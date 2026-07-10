/**
 * requireBearerAuthRetryable — 503+Retry-After on transient token-store
 * failures, byte-for-byte SDK behavior otherwise.
 *
 * Regression guard for the 2026-07-10 diagnosis: a 500 on the MCP `initialize`
 * handshake makes Claude Code abort tool discovery for the whole session. This
 * middleware turns a TRANSIENT verifyAccessToken failure (AuthDbTimeoutError /
 * DB connection blip) into a retryable 503 instead, while keeping bad/expired
 * tokens at 401 and real logic errors at 500.
 */
import { describe, test, expect } from 'bun:test';
import {
  requireBearerAuthRetryable,
  isTransientAuthError,
  DEFAULT_AUTH_RETRY_AFTER_S,
} from '../src/core/retryable-bearer-auth.ts';
import { AuthDbTimeoutError } from '../src/core/oauth-provider.ts';
import {
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

// Minimal Express res double that records what the middleware emitted.
function fakeRes() {
  const rec: { status?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  const res: any = {
    set(k: string, v: string) { rec.headers[k] = v; return res; },
    status(code: number) { rec.status = code; return res; },
    json(body: any) { rec.body = body; return res; },
  };
  return { res, rec };
}

const reqWith = (auth?: string): any => ({ headers: auth ? { authorization: auth } : {} });

describe('isTransientAuthError', () => {
  test('AuthDbTimeoutError is transient', () => {
    expect(isTransientAuthError(new AuthDbTimeoutError())).toBe(true);
  });
  test('DB connection errors are transient (message + code)', () => {
    expect(isTransientAuthError(new Error('write CONNECT_TIMEOUT 127.0.0.1:5437'))).toBe(true);
    expect(isTransientAuthError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransientAuthError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });
  test('auth errors and generic errors are NOT transient', () => {
    expect(isTransientAuthError(new InvalidTokenError('Token has expired'))).toBe(false);
    expect(isTransientAuthError(new ServerError('boom'))).toBe(false);
    expect(isTransientAuthError(new Error('undefined column source_id'))).toBe(false);
  });
});

describe('requireBearerAuthRetryable', () => {
  const okAuth = { scopes: ['read', 'write'], expiresAt: Math.floor(Date.now() / 1000) + 3600 };

  test('transient failure → 503 + Retry-After, does NOT call next', async () => {
    let nexted = false;
    const mw = requireBearerAuthRetryable({
      verifier: { verifyAccessToken: async () => { throw new AuthDbTimeoutError(); } },
    });
    const { res, rec } = fakeRes();
    await mw(reqWith('Bearer tok'), res, () => { nexted = true; });
    expect(rec.status).toBe(503);
    expect(rec.headers['Retry-After']).toBe(String(DEFAULT_AUTH_RETRY_AFTER_S));
    expect(rec.body.error).toBe('service_unavailable');
    expect(nexted).toBe(false);
  });

  test('valid token → sets req.auth and calls next', async () => {
    let nexted = false;
    const req = reqWith('Bearer tok');
    const mw = requireBearerAuthRetryable({
      verifier: { verifyAccessToken: async () => okAuth as any },
    });
    const { res, rec } = fakeRes();
    await mw(req, res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(rec.status).toBeUndefined(); // no error response written
    expect(req.auth).toBe(okAuth);
  });

  test('missing header → 401 with WWW-Authenticate (SDK parity)', async () => {
    const mw = requireBearerAuthRetryable({
      verifier: { verifyAccessToken: async () => okAuth as any },
    });
    const { res, rec } = fakeRes();
    await mw(reqWith(undefined), res, () => {});
    expect(rec.status).toBe(401);
    expect(rec.headers['WWW-Authenticate']).toContain('Bearer error="invalid_token"');
  });

  test('expired token → 401, never 503', async () => {
    const mw = requireBearerAuthRetryable({
      verifier: { verifyAccessToken: async () => ({ scopes: [], expiresAt: 1 } as any) },
    });
    const { res, rec } = fakeRes();
    await mw(reqWith('Bearer tok'), res, () => {});
    expect(rec.status).toBe(401);
  });

  test('unknown non-transient throw → 500 server_error (SDK parity)', async () => {
    const mw = requireBearerAuthRetryable({
      verifier: { verifyAccessToken: async () => { throw new Error('logic bug'); } },
    });
    const { res, rec } = fakeRes();
    await mw(reqWith('Bearer tok'), res, () => {});
    expect(rec.status).toBe(500);
    expect(rec.body.error).toBe('server_error');
  });
});
