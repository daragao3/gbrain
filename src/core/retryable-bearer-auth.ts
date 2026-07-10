/**
 * Bearer-auth middleware: a faithful mirror of the MCP SDK's requireBearerAuth
 * (@modelcontextprotocol/sdk .../server/auth/middleware/bearerAuth.js)
 * with ONE added branch — when verifyAccessToken fails for a TRANSIENT reason,
 * respond HTTP 503 + Retry-After instead of the SDK's generic 500 server_error.
 *
 * Why (2026-07-10 diagnosis): every POST /mcp — including the MCP `initialize`
 * handshake — is gated by this middleware → oauthProvider.verifyAccessToken,
 * which reads the token row from Postgres. Under DB/commit pressure that read
 * could hang, and the SDK maps any non-OAuthError to a 500 `server_error`. A
 * 500 on `initialize` makes Claude Code abort tool discovery for the WHOLE
 * session (no in-session retry) — the server shows "Connected" but exposes
 * zero tools. 503 + Retry-After is the semantically correct "transient, retry
 * me" signal, so a well-behaved client backs off and retries rather than
 * giving up on tool discovery. Pairs with readWithAuthDbTimeout in
 * oauth-provider.ts, which bounds the read so the 503 arrives fast (~2×timeout)
 * instead of after the ~10s driver hang.
 *
 * Every other outcome — 401 InvalidToken (+ WWW-Authenticate), 403
 * InsufficientScope (+ WWW-Authenticate), 400 OAuthError, 500 for a genuine
 * ServerError or an unknown non-transient throw — is byte-for-byte the SDK
 * behavior, so the auth contract does not regress.
 */
import type { Request, Response, NextFunction } from 'express';
import {
  InvalidTokenError,
  InsufficientScopeError,
  ServerError,
  OAuthError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthDbTimeoutError } from './oauth-provider.ts';

/** Default Retry-After (seconds) advertised on a transient-auth 503. */
export const DEFAULT_AUTH_RETRY_AFTER_S = 2;

/**
 * True when a verifyAccessToken failure is transient/retryable rather than a
 * client or logic error.
 *
 * `AuthDbTimeoutError` is the primary, well-defined signal — the bounded token
 * read (readWithAuthDbTimeout) gave up after its retry. We also match a
 * conservative set of driver connection-error shapes so a "DB momentarily
 * unreachable" throw (e.g. a Docker/WSL blip on :5437, which surfaces as
 * `write CONNECT_TIMEOUT 127.0.0.1:5437`) is surfaced as retryable too.
 *
 * OAuthError subclasses (InvalidToken, InsufficientScope, …) are deterministic
 * auth outcomes and are explicitly excluded — a bad/expired token must stay a
 * 401/403, never a 503. Pure + exported for unit tests.
 */
export function isTransientAuthError(err: unknown): boolean {
  if (err instanceof AuthDbTimeoutError) return true;
  if (err instanceof OAuthError) return false;
  const msg = err instanceof Error ? err.message : '';
  const codeRaw = (err as { code?: unknown } | null)?.code;
  const code = typeof codeRaw === 'string' ? codeRaw : '';
  return (
    /CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection (?:terminated|closed|refused)|pool[^]*timeout|timeout exceeded when trying to connect/i.test(msg) ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'CONNECT_TIMEOUT'
  );
}

export interface RetryableBearerAuthOptions {
  verifier: Pick<OAuthServerProvider, 'verifyAccessToken'>;
  requiredScopes?: string[];
  resourceMetadataUrl?: string;
  /** Retry-After seconds on a transient 503. Default DEFAULT_AUTH_RETRY_AFTER_S. */
  retryAfterSeconds?: number;
}

export function requireBearerAuthRetryable(opts: RetryableBearerAuthOptions) {
  const {
    verifier,
    requiredScopes = [],
    resourceMetadataUrl,
    retryAfterSeconds = DEFAULT_AUTH_RETRY_AFTER_S,
  } = opts;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        throw new InvalidTokenError('Missing Authorization header');
      }
      const [type, token] = authHeader.split(' ');
      if (type?.toLowerCase() !== 'bearer' || !token) {
        throw new InvalidTokenError("Invalid Authorization header format, expected 'Bearer TOKEN'");
      }
      const authInfo = await verifier.verifyAccessToken(token);
      if (requiredScopes.length > 0) {
        const hasAllScopes = requiredScopes.every(scope => authInfo.scopes.includes(scope));
        if (!hasAllScopes) {
          throw new InsufficientScopeError('Insufficient scope');
        }
      }
      if (typeof authInfo.expiresAt !== 'number' || isNaN(authInfo.expiresAt)) {
        throw new InvalidTokenError('Token has no expiration time');
      } else if (authInfo.expiresAt < Date.now() / 1000) {
        throw new InvalidTokenError('Token has expired');
      }
      (req as Request & { auth?: unknown }).auth = authInfo;
      next();
    } catch (error) {
      const buildWwwAuthHeader = (errorCode: string, message: string) => {
        let header = `Bearer error="${errorCode}", error_description="${message}"`;
        if (requiredScopes.length > 0) header += `, scope="${requiredScopes.join(' ')}"`;
        if (resourceMetadataUrl) header += `, resource_metadata="${resourceMetadataUrl}"`;
        return header;
      };
      if (error instanceof InvalidTokenError) {
        res.set('WWW-Authenticate', buildWwwAuthHeader(error.errorCode, error.message));
        res.status(401).json(error.toResponseObject());
      } else if (error instanceof InsufficientScopeError) {
        res.set('WWW-Authenticate', buildWwwAuthHeader(error.errorCode, error.message));
        res.status(403).json(error.toResponseObject());
      } else if (isTransientAuthError(error)) {
        // NEW branch: transient token-store failure → retryable, not a hard 500.
        res.set('Retry-After', String(retryAfterSeconds));
        res.status(503).json({
          error: 'service_unavailable',
          error_description:
            'Auth token lookup timed out; the token store is briefly unavailable. Retry.',
        });
      } else if (error instanceof ServerError) {
        res.status(500).json(error.toResponseObject());
      } else if (error instanceof OAuthError) {
        res.status(400).json(error.toResponseObject());
      } else {
        const serverError = new ServerError('Internal Server Error');
        res.status(500).json(serverError.toResponseObject());
      }
    }
  };
}
