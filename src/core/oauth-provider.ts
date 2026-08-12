/**
 * GBrain OAuth 2.1 Provider — implements MCP SDK's OAuthServerProvider.
 *
 * Backed by raw SQL (PGLite or Postgres), not the BrainEngine interface.
 * OAuth is infrastructure, not brain operations.
 *
 * Supports:
 * - Client registration (manual via CLI or Dynamic Client Registration)
 * - Authorization code flow with PKCE (for ChatGPT, browser-based clients)
 * - Client credentials flow (for machine-to-machine: Perplexity, Claude)
 * - Token refresh with rotation
 * - Token revocation
 * - Legacy access_tokens fallback for backward compat
 */

import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo as SdkAuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hashToken, generateToken, isUndefinedColumnError } from './utils.ts';
import { assertValidSourceId } from './source-id.ts';
import { hasScope, assertAllowedScopes, parseScopeString, InvalidScopeError } from './scope.ts';
import type { AuthInfo as CoreAuthInfo } from './operations.ts';
import { parseLegacyTokenScope } from './legacy-token-scope.ts';
import type { SqlQuery, SqlValue } from './sql-query.ts';
export type { SqlQuery, SqlValue };

export interface AgentClientBindings {
  boundTools?: string[];
  boundSourceId?: string;
  boundBrainId?: string;
  boundSlugPrefixes?: string[];
  boundMaxConcurrent?: number;
  budgetUsdPerDay?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Convert a JS array to a PostgreSQL array literal for PGLite compat.
 *
 * PGLite's `db.query(sql, params)` rejects JS arrays bound directly to TEXT[]
 * columns ("insufficient data left in message"), so we hand-build the array
 * literal `{...}` and let Postgres parse it on insert.
 *
 * SECURITY: every element is wrapped in double quotes with `"` and `\`
 * escaped. Without this, an element containing a comma (e.g., a malicious
 * `redirect_uri` containing `,`) would be parsed by Postgres as MULTIPLE
 * array elements, smuggling values past validation. See CSO finding #5.
 */
function pgArray(arr: string[]): string {
  if (!arr || arr.length === 0) return '{}';
  const escaped = arr.map(s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}

/**
 * Allow-list of RFC 7591 §2 `token_endpoint_auth_method` values gbrain
 * accepts at registration. Three values, chosen because the SDK's
 * `mcpAuthRouter` advertises exactly these three in
 * `token_endpoint_auth_methods_supported`:
 *
 * - `client_secret_post` — confidential client; secret in body (default)
 * - `client_secret_basic` — confidential client; secret in Authorization header
 * - `none` — public PKCE-only client (Claude Code, Cursor, ChatGPT custom connector)
 *
 * Three call sites enforce this set:
 *   1. CLI `gbrain auth register-client` (src/commands/auth.ts)
 *   2. Admin `POST /admin/api/register-client` (src/commands/serve-http.ts)
 *   3. DCR `POST /register` (this file, GBrainClientsStore.registerClient)
 *
 * **Read-tolerant by design.** `getClient` returns whatever is stored
 * verbatim — legacy rows with non-allowlist values (e.g. pre-v0.41.3
 * direct UPDATEs) continue to function. The validator gates new writes
 * ONLY; we don't break operators with hand-edited rows on upgrade.
 */
export type TokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic' | 'none';

export const ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS = new Set<TokenEndpointAuthMethod>([
  'client_secret_post',
  'client_secret_basic',
  'none',
]);

export class InvalidTokenEndpointAuthMethodError extends Error {
  readonly code = 'invalid_token_endpoint_auth_method';
  constructor(value: unknown) {
    super(
      `Invalid token_endpoint_auth_method: ${JSON.stringify(value)}. ` +
      `Expected one of: ${Array.from(ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS).join(', ')}. ` +
      `RFC 7591 §2 — see https://datatracker.ietf.org/doc/html/rfc7591#section-2.`,
    );
    this.name = 'InvalidTokenEndpointAuthMethodError';
  }
}

/**
 * Validate a token_endpoint_auth_method value at the registration boundary.
 * Throws `InvalidTokenEndpointAuthMethodError` on rejection; returns the
 * typed value on success. Returns `'client_secret_post'` for undefined input
 * (RFC 7591 default).
 *
 * Apply at every registration entry point (CLI, admin endpoint, DCR). Do
 * NOT apply on read — legacy oauth_clients rows with non-allowlist values
 * must continue to function unchanged.
 */
export function validateTokenEndpointAuthMethod(value: unknown): TokenEndpointAuthMethod {
  if (value === undefined || value === null || value === '') return 'client_secret_post';
  if (typeof value !== 'string') throw new InvalidTokenEndpointAuthMethodError(value);
  if (!ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS.has(value as TokenEndpointAuthMethod)) {
    throw new InvalidTokenEndpointAuthMethodError(value);
  }
  return value as TokenEndpointAuthMethod;
}

/**
 * Validate a redirect_uri per RFC 6749 §3.1.2.1.
 *
 * Production redirect_uris MUST be HTTPS. The only allowed plaintext
 * exceptions are loopback (127.0.0.1, ::1, localhost) which are unreachable
 * from the network. Throws a descriptive error on rejection.
 *
 * Used by the DCR (Dynamic Client Registration) path; the CLI registration
 * path trusts the operator and bypasses this gate.
 */
function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid redirect_uri: not a parseable URL: ${uri}`);
  }
  const isLoopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
    || parsed.hostname === '::1';
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback) return;
  throw new Error(
    `redirect_uri must use https:// (or http://localhost for loopback): ${uri}`,
  );
}

/**
 * Coerce an OAuth timestamp column (Unix epoch seconds, BIGINT) into a JS
 * number, or undefined for SQL NULL.
 *
 * Why this exists: postgres.js with `prepare: false` (the auto-detected setting
 * on Supabase PgBouncer / port 6543; see src/core/db.ts:resolvePrepare) returns
 * BIGINT columns as strings. Two surfaces break on that: (1) the MCP SDK's
 * bearerAuth middleware checks `typeof authInfo.expiresAt === 'number'` and
 * rejects strings; (2) RFC 7591 §3.2.1 requires `client_id_issued_at` and
 * `client_secret_expires_at` to be JSON numbers in DCR responses, not strings.
 *
 * Throws on non-finite (NaN/Infinity) so corrupt rows fail loud at the boundary
 * instead of letting `expiresAt: NaN` flow through to the SDK as a fake-valid
 * token. Returns undefined for SQL NULL so callers decide NULL semantics
 * explicitly. For OAuth, the comparison sites treat NULL as "expired"
 * (fail-closed); the DCR response sites preserve undefined per RFC 7591
 * (the `client_secret_expires_at` field is optional, undefined means
 * "did not expire").
 */
export function coerceTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`coerceTimestamp: non-finite timestamp value ${JSON.stringify(value)}`);
  }
  return n;
}

interface GBrainOAuthProviderOptions {
  sql: SqlQuery;
  /** Default token TTL in seconds (default: 3600 = 1 hour) */
  tokenTtl?: number;
  /** Default refresh token TTL in seconds (default: 30 days) */
  refreshTtl?: number;
  /**
   * Disable Dynamic Client Registration (RFC 7591) while keeping the rest of
   * the OAuth surface intact. When true, `clientsStore.registerClient` is not
   * surfaced to the SDK router, so POST `/register` returns 404 even though
   * the underlying provider can still register clients programmatically via
   * `registerClientManual`. Replaces the previous monkey-patching pattern in
   * serve-http.ts (cleanup, not a security fix — DCR was never reachable
   * before mcpAuthRouter ran).
   */
  dcrDisabled?: boolean;
  /**
   * Allow the consent-bypassing `client_credentials` grant on the unauthenticated
   * Dynamic Client Registration path. Default false (#1353): a self-registered
   * DCR client defaults to `authorization_code` (which goes through /authorize
   * consent), and an explicit `client_credentials` request is rejected. Operators
   * who genuinely need machine-to-machine DCR clients opt in via
   * `--enable-dcr-insecure`. Manual CLI / admin registration is unaffected
   * (operator-trusted, registers grants directly).
   */
  allowClientCredentialsDcr?: boolean;
  /**
   * Per-read timeout (ms) for the token-lookup reads in verifyAccessToken.
   * Defaults to resolveAuthDbTimeoutMs(GBRAIN_AUTH_DB_TIMEOUT_MS) → 2500.
   * See readWithAuthDbTimeout for the rationale.
   */
  authDbTimeoutMs?: number;
  /**
   * Lifetime (ms) of a memoized successful token verification. Defaults to
   * resolveAuthCacheTtlMs(GBRAIN_AUTH_CACHE_TTL_MS) → 30000. `0` disables the
   * memo. See DEFAULT_AUTH_CACHE_TTL_MS for why bounding the read was not
   * enough on its own.
   */
  authCacheTtlMs?: number;

  /**
   * Lifetime (ms) of a memoized DEFINITIVE not-found. Defaults to
   * resolveAuthNegativeCacheTtlMs(GBRAIN_AUTH_NEGATIVE_CACHE_TTL_MS) → 2000.
   * `0` disables negative memoization.
   */
  authNegativeCacheTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Clients Store
// ---------------------------------------------------------------------------

class GBrainClientsStore implements OAuthRegisteredClientsStore {
  constructor(private sql: SqlQuery, private allowClientCredentialsDcr = false) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const rows = await this.sql`
      SELECT client_id, client_secret_hash, client_name, redirect_uris,
             grant_types, scope, token_endpoint_auth_method,
             client_id_issued_at, client_secret_expires_at
      FROM oauth_clients WHERE client_id = ${clientId}
    `;
    if (rows.length === 0) return undefined;
    const r = rows[0];
    // v0.34.1 (#909): public clients (token_endpoint_auth_method='none')
    // have client_secret_hash = NULL. Normalize SQL NULL to JS undefined
    // so SDK middleware that checks `client.client_secret === undefined`
    // (not `=== null`) correctly identifies the client as public and
    // skips the secret-comparison branch on /token.
    const rawSecret = r.client_secret_hash;
    return {
      client_id: r.client_id as string,
      client_secret: rawSecret == null ? undefined : (rawSecret as string),
      client_name: r.client_name as string,
      redirect_uris: (r.redirect_uris as string[]) || [],
      grant_types: (r.grant_types as string[]) || ['client_credentials'],
      scope: r.scope as string | undefined,
      token_endpoint_auth_method: r.token_endpoint_auth_method as string | undefined,
      client_id_issued_at: coerceTimestamp(r.client_id_issued_at),
      client_secret_expires_at: coerceTimestamp(r.client_secret_expires_at),
    };
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    // Enforce HTTPS for all redirect_uris on the DCR path (RFC 6749 §3.1.2.1).
    // Without this, an attacker could register a non-loopback http:// URI and
    // exfiltrate auth codes over plaintext. CLI registrations bypass this gate
    // (operators are trusted; they can register http:// for testing).
    for (const uri of client.redirect_uris || []) {
      validateRedirectUri(String(uri));
    }

    // v0.28: ALLOWED_SCOPES allowlist. RFC 6749 §5.2 invalid_scope. The DCR
    // path is reachable by any unauthenticated network caller when --enable-dcr
    // is on, so this is the security-relevant gate (manual CLI registration
    // is operator-trusted).
    assertAllowedScopes(parseScopeString(client.scope));

    // v0.41.3 (T5): validate token_endpoint_auth_method on the DCR path so
    // `--enable-dcr` is not the looser entry point. CLI and admin paths gate
    // through the same `validateTokenEndpointAuthMethod` helper — all three
    // registration entry points share one allow-list.
    const authMethod = validateTokenEndpointAuthMethod(client.token_endpoint_auth_method);

    // v0.42 (#1353): the DCR path is the unauthenticated network entry point.
    // `client_credentials` skips /authorize consent entirely, so a self-
    // registered DCR client must NOT get it by default. Default the grant to
    // `authorization_code` (the consent-bearing flow) when unspecified, and
    // reject an explicit `client_credentials` request unless the operator opted
    // in via `--enable-dcr-insecure`. Manual CLI/admin registration bypasses
    // this store method, so operators can still mint machine clients directly.
    const grantTypes = (client.grant_types && client.grant_types.length > 0)
      ? client.grant_types
      : ['authorization_code'];
    if (!this.allowClientCredentialsDcr && grantTypes.includes('client_credentials')) {
      throw new InvalidClientMetadataError(
        'client_credentials grant is not permitted via dynamic client registration; ' +
        'restart the server with --enable-dcr-insecure to allow it, or register the ' +
        'client via the gbrain CLI / admin API.',
      );
    }

    const clientId = generateToken('gbrain_cl_');
    // v0.34.1 (#909): RFC 7591 §2 — clients that authenticate at the token
    // endpoint via PKCE alone declare `token_endpoint_auth_method: "none"`.
    // For those clients the authorization server MUST NOT issue a client
    // secret. Pre-fix, unconditional secret generation made the MCP SDK's
    // clientAuth middleware check `client.client_secret` on every request,
    // rejecting valid public-client (Claude Code, Cursor) flows.
    //
    // We persist secret_hash = NULL for public clients so `getClient` and
    // the SDK's clientAuth path can detect them via `client_secret_hash IS
    // NULL` and skip the secret comparison. Confidential clients (default
    // `client_secret_post` and explicit `client_secret_basic`) still mint
    // a secret as before.
    const isPublicClient = authMethod === 'none';
    const clientSecret = isPublicClient ? undefined : generateToken('gbrain_cs_');
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    // v0.34.1 (#861, D2 + D13 + #876): DCR clients get source_id='default'
    // (matches legacy fallback) and federated_read=['default'] (read scope
    // == write scope). Operators who need narrower / wider scope rescope
    // via the CLI later. Pre-v60/v61 brain falls through to the legacy
    // projection (no source_id / federated_read column yet).
    try {
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, token_endpoint_auth_method,
                                    client_id_issued_at, source_id, federated_read)
        VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                ${pgArray((client.redirect_uris || []).map(String))},
                ${pgArray(grantTypes)},
                ${client.scope || ''}, ${authMethod},
                ${now}, ${'default'}, ${pgArray(['default'])})
      `;
    } catch (err) {
      if (isUndefinedColumnError(err, 'federated_read')) {
        try {
          await this.sql`
            INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                        grant_types, scope, token_endpoint_auth_method,
                                        client_id_issued_at, source_id)
            VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                    ${pgArray((client.redirect_uris || []).map(String))},
                    ${pgArray(grantTypes)},
                    ${client.scope || ''}, ${authMethod},
                    ${now}, ${'default'})
          `;
        } catch (err2) {
          if (isUndefinedColumnError(err2, 'source_id')) {
            await this.sql`
              INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                          grant_types, scope, token_endpoint_auth_method,
                                          client_id_issued_at)
              VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                      ${pgArray((client.redirect_uris || []).map(String))},
                      ${pgArray(grantTypes)},
                      ${client.scope || ''}, ${authMethod},
                      ${now})
            `;
          } else {
            throw err2;
          }
        }
      } else if (isUndefinedColumnError(err, 'source_id')) {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at)
          VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                  ${pgArray((client.redirect_uris || []).map(String))},
                  ${pgArray(grantTypes)},
                  ${client.scope || ''}, ${authMethod},
                  ${now})
        `;
      } else {
        throw err;
      }
    }

    // Public clients: omit `client_secret` entirely from the response so
    // the wire payload matches RFC 7591 §3.2.1 ("if the client is a
    // public client, the authorization server MUST NOT issue a client
    // secret"). Confidential clients return the freshly-generated secret
    // exactly once — same shape as before.
    const response: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: now,
    };
    if (clientSecret) response.client_secret = clientSecret;
    return response;
  }
}

// ---------------------------------------------------------------------------
// Auth DB read resilience (2026-07-10 diagnosis)
// ---------------------------------------------------------------------------

/**
 * Default per-read bound for the token-lookup SELECTs in verifyAccessToken.
 * A single indexed lookup on token_hash answers in <100ms on a healthy brain;
 * 2.5s is generous headroom for pool queueing without letting one read hold
 * the client's MCP `initialize` connect window open for the full driver
 * timeout (~10s observed under commit pressure). Override with
 * GBRAIN_AUTH_DB_TIMEOUT_MS.
 */
export const DEFAULT_AUTH_DB_TIMEOUT_MS = 2500;

/** Parse GBRAIN_AUTH_DB_TIMEOUT_MS; fall back to the default on unset/invalid. */
export function resolveAuthDbTimeoutMs(env: string | undefined): number {
  if (!env) return DEFAULT_AUTH_DB_TIMEOUT_MS;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AUTH_DB_TIMEOUT_MS;
}

/**
 * Default lifetime of a memoized token verification (2026-07-27 diagnosis).
 *
 * No timeout value fixes the `initialize` 503, because the queries were never
 * slow: EXPLAIN ANALYZE puts both token lookups at ~0.05ms, and during a stall
 * pg_stat_activity shows every gbrain backend idle / wait_event=ClientRead —
 * Postgres has ALREADY answered and is waiting on a client that isn't draining
 * its sockets, because the host is CPU-saturated. Raising the bound just walks
 * the failure signature along with it (13s@2500 → 19s@6000 → 29s@15000, then
 * the driver's own hardcoded connect_timeout).
 *
 * The fix is to stop asking. The shared loopback token is a STATIC secret on
 * disk backed by a single legacy access_tokens row, so re-verifying it on every
 * POST /mcp is pure waste. 30s is short enough that an out-of-process
 * revocation (`gbrain auth revoke`, which runs in a separate process and cannot
 * invalidate this map) takes effect promptly, and long enough that a burst of
 * handshakes costs exactly one read. Override with GBRAIN_AUTH_CACHE_TTL_MS;
 * `0` disables memoization entirely.
 */
export const DEFAULT_AUTH_CACHE_TTL_MS = 30_000;

/**
 * Lifetime of a memoized FAILED verification.
 *
 * Deliberately orders of magnitude below DEFAULT_AUTH_CACHE_TTL_MS: a negative
 * entry denies service, so it earns far less trust than a positive one. The
 * bound that matters is the mint race called out in setCachedAuth's docstring —
 * a token created between a client's 401 and its retry is rejected for at most
 * this long.
 *
 * Why cache failures at all, when the original design explicitly did not:
 * measured 2026-08-12, the 401 path was the SLOWEST request the :7483 server
 * served (9.07 / 13.40 / 22.17 / 27.21s, against a static no-DB route at
 * 0.09-0.79s in the same window), because it is the only path that always
 * reaches Postgres. A client holding a stale token therefore amplifies its own
 * failures — each 401 pays a cold pool open and leaves the server busier for
 * the next one. Two seconds is enough to collapse that and short enough that
 * the mint race stays invisible.
 *
 * Only a DEFINITIVE not-found is cached — never an AuthDbTimeoutError or a
 * column-probe failure. Caching a transient infrastructure fault as "invalid"
 * would convert a blip into a guaranteed window of hard 401s.
 * Regression: test/auth-negative-cache.test.ts.
 */
export const DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS = 2_000;

/** Parse GBRAIN_AUTH_NEGATIVE_CACHE_TTL_MS; `0` disables negative memoization. */
export function resolveAuthNegativeCacheTtlMs(env: string | undefined): number {
  if (env === undefined || env === '') return DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS;
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS;
}

/**
 * Parse GBRAIN_AUTH_CACHE_TTL_MS; fall back to the default on unset/invalid.
 *
 * Unlike resolveAuthDbTimeoutMs, an explicit `0` is HONORED rather than
 * coerced to the default — it is the operator's off-switch for the memo.
 */
export function resolveAuthCacheTtlMs(env: string | undefined): number {
  if (env === undefined || env === '') return DEFAULT_AUTH_CACHE_TTL_MS;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AUTH_CACHE_TTL_MS;
}

/** Upper bound on memoized entries — a backstop, not a working limit. */
const AUTH_CACHE_MAX_ENTRIES = 500;

/** A memoized successful verification, valid until `notAfterMs` (epoch ms). */
interface AuthCacheEntry {
  info: CoreAuthInfo;
  notAfterMs: number;
}

/**
 * Thrown when a token-lookup read exceeds its timeout on BOTH the initial
 * attempt and the single retry — reached in ~2×timeout instead of the ~10s
 * driver hang, and only after a retry has had a chance to absorb a momentary
 * pool-saturation blip. `requireBearerAuthRetryable` (retryable-bearer-auth.ts)
 * classifies this as transient and returns HTTP 503 + Retry-After so the
 * client backs off and retries rather than treating it as a hard failure.
 * (Under the stock SDK requireBearerAuth it would instead map to a 500
 * server_error, since it is deliberately not an OAuthError subclass.)
 */
export class AuthDbTimeoutError extends Error {
  constructor(message = 'auth token lookup timed out') {
    super(message);
    this.name = 'AuthDbTimeoutError';
  }
}

/**
 * Race a token-lookup read against `timeoutMs`; on timeout, abandon and retry
 * ONCE, then throw AuthDbTimeoutError.
 *
 * Motivation (2026-07-10 diagnosis): every POST /mcp — including the MCP
 * `initialize` handshake — is gated by requireBearerAuth → verifyAccessToken,
 * which reads the token row from Postgres. Under DB/commit pressure that read
 * hung ~10s before the driver threw; the raw throw became an SDK ServerError
 * 500 (bearerAuth.js maps any non-OAuthError → server_error), and a 500 on
 * `initialize` makes Claude Code abort tool discovery for the WHOLE session
 * (no in-session retry) — the server shows "Connected" but exposes zero tools.
 * The 10s hang also burned the client's own connect-retry budget.
 *
 * Design notes:
 *  - Only TIMEOUTS are retried. A timeout means "no deterministic answer yet",
 *    so a second attempt is safe and often succeeds once a transient blip
 *    clears (matches the observed "500 twice then 200 on retry" read pattern).
 *  - Non-timeout rejections propagate UNCHANGED and are NOT retried. This
 *    preserves verifyAccessToken's isUndefinedColumnError column-probe fallback
 *    (a deterministic schema error must not be retried or masked) and every
 *    existing auth-logic path.
 *  - Promise.race cannot cancel the abandoned query; it keeps running on its
 *    pool connection. These are single-row indexed SELECTs, so the residual
 *    load is negligible versus holding the caller (and a connection) ~10s.
 */
export async function readWithAuthDbTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number = DEFAULT_AUTH_DB_TIMEOUT_MS,
): Promise<T> {
  const TIMED_OUT = Symbol('auth_db_timed_out');
  for (let attempt = 0; attempt < 2; attempt++) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race<T | typeof TIMED_OUT>([
        run(),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        }),
      ]);
      if (result !== TIMED_OUT) return result as T;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  throw new AuthDbTimeoutError();
}

// ---------------------------------------------------------------------------
// OAuth Provider
// ---------------------------------------------------------------------------

export class GBrainOAuthProvider implements OAuthServerProvider {
  private sql: SqlQuery;
  private _clientsStore: GBrainClientsStore;
  private readonly dcrDisabled: boolean;
  private tokenTtl: number;
  private refreshTtl: number;
  private readonly authDbTimeoutMs: number;
  private readonly authCacheTtlMs: number;
  /**
   * Memoized successful verifications, keyed by token HASH (never the
   * plaintext). Per-INSTANCE, deliberately not module-global: the CLI builds
   * its own short-lived provider, and a shared map would leak across both
   * processes-in-one and tests.
   */
  private readonly tokenCache = new Map<string, AuthCacheEntry>();
  /**
   * Memoized DEFINITIVE not-found verifications, hash → expiry (epoch ms).
   * Separate from tokenCache so the two lifetimes can never be confused and a
   * negative entry can never be mistaken for an AuthInfo.
   */
  private readonly negativeCache = new Map<string, number>();
  private readonly authNegativeCacheTtlMs: number;

  constructor(options: GBrainOAuthProviderOptions) {
    this.sql = options.sql;
    this._clientsStore = new GBrainClientsStore(this.sql, options.allowClientCredentialsDcr === true);
    this.dcrDisabled = options.dcrDisabled === true;
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
    this.authDbTimeoutMs = options.authDbTimeoutMs
      ?? resolveAuthDbTimeoutMs(process.env.GBRAIN_AUTH_DB_TIMEOUT_MS);
    this.authCacheTtlMs = options.authCacheTtlMs
      ?? resolveAuthCacheTtlMs(process.env.GBRAIN_AUTH_CACHE_TTL_MS);
    this.authNegativeCacheTtlMs = options.authNegativeCacheTtlMs
      ?? resolveAuthNegativeCacheTtlMs(process.env.GBRAIN_AUTH_NEGATIVE_CACHE_TTL_MS);
  }

  /** True while this hash is inside its negative-memo window. */
  private isNegativeCached(tokenHash: string): boolean {
    if (this.authNegativeCacheTtlMs <= 0) return false;
    const notAfterMs = this.negativeCache.get(tokenHash);
    if (notAfterMs === undefined) return false;
    if (Date.now() >= notAfterMs) {
      this.negativeCache.delete(tokenHash);
      return false;
    }
    return true;
  }

  /**
   * Memoize a DEFINITIVE not-found. Callers must not route transient failures
   * (AuthDbTimeoutError, column probes) here — see
   * DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS.
   */
  private setNegativeCached(tokenHash: string): void {
    if (this.authNegativeCacheTtlMs <= 0) return;
    if (this.negativeCache.size >= AUTH_CACHE_MAX_ENTRIES) {
      const nowMs = Date.now();
      for (const [k, v] of this.negativeCache) {
        if (nowMs >= v) this.negativeCache.delete(k);
      }
      if (this.negativeCache.size >= AUTH_CACHE_MAX_ENTRIES) {
        const oldest = this.negativeCache.keys().next();
        if (!oldest.done) this.negativeCache.delete(oldest.value);
      }
    }
    this.negativeCache.set(tokenHash, Date.now() + this.authNegativeCacheTtlMs);
  }

  /**
   * Drop every memoized verification.
   *
   * Called by the admin revoke-by-NAME endpoint, which cannot compute the
   * token hash it needs to evict a single entry. Revocation is rare and the
   * map is small, so a blanket clear is the correct trade — it closes the
   * in-process staleness window completely rather than leaving a token
   * usable for the rest of its TTL.
   */
  clearTokenCache(): void {
    this.tokenCache.clear();
    // Clear negatives too. A blanket clear is also the operator's "I just
    // changed the token table, re-read everything" lever, and leaving stale
    // 401s behind would make a freshly minted key look broken.
    this.negativeCache.clear();
  }

  /** Evict one token's memoized verification (used on targeted revocation). */
  private invalidateTokenHash(tokenHash: string): void {
    this.tokenCache.delete(tokenHash);
    this.negativeCache.delete(tokenHash);
  }

  /**
   * Return a memoized AuthInfo for this hash, or undefined on miss/expiry.
   *
   * Re-checks the token's OWN expiry on every hit, independently of the memo
   * TTL — belt and braces alongside the notAfterMs clamp applied at store
   * time, so an expired token can never be served from memory.
   */
  private getCachedAuth(tokenHash: string): CoreAuthInfo | undefined {
    if (this.authCacheTtlMs <= 0) return undefined;
    const entry = this.tokenCache.get(tokenHash);
    if (!entry) return undefined;
    const nowMs = Date.now();
    if (nowMs >= entry.notAfterMs) {
      this.tokenCache.delete(tokenHash);
      return undefined;
    }
    if (typeof entry.info.expiresAt === 'number'
      && entry.info.expiresAt < Math.floor(nowMs / 1000)) {
      this.tokenCache.delete(tokenHash);
      return undefined;
    }
    // Hand back a COPY. Downstream assigns this to req.auth; a mutation there
    // (or in any operation handler) must not contaminate the next request.
    return {
      ...entry.info,
      scopes: [...entry.info.scopes],
      allowedSources: entry.info.allowedSources
        ? [...entry.info.allowedSources]
        : entry.info.allowedSources,
    };
  }

  /**
   * Memoize a SUCCESSFUL verification. Failures are never cached: an unknown,
   * revoked, or expired token must re-read so it keeps returning 401/403, and
   * a token minted a moment ago must not be rejected for the rest of the TTL.
   *
   * The entry expires at min(now + ttl, token expiry) so the memo can never
   * extend a token's life by even a second.
   */
  private setCachedAuth(tokenHash: string, info: CoreAuthInfo): void {
    // A hash that just verified is not a not-found any more. Drop the negative
    // entry unconditionally — before the TTL guard below, so this still holds
    // when the positive memo is disabled.
    this.negativeCache.delete(tokenHash);
    if (this.authCacheTtlMs <= 0) return;
    let notAfterMs = Date.now() + this.authCacheTtlMs;
    if (typeof info.expiresAt === 'number') {
      notAfterMs = Math.min(notAfterMs, info.expiresAt * 1000);
    }
    if (notAfterMs <= Date.now()) return; // already expired — nothing to cache
    if (this.tokenCache.size >= AUTH_CACHE_MAX_ENTRIES) {
      // Opportunistic prune of lapsed entries; if that frees nothing, drop the
      // oldest insertion (Map preserves insertion order) so the map stays bounded.
      const nowMs = Date.now();
      for (const [k, v] of this.tokenCache) {
        if (nowMs >= v.notAfterMs) this.tokenCache.delete(k);
      }
      if (this.tokenCache.size >= AUTH_CACHE_MAX_ENTRIES) {
        const oldest = this.tokenCache.keys().next();
        if (!oldest.done) this.tokenCache.delete(oldest.value);
      }
    }
    // Store a SNAPSHOT, not the object handed back to this caller. The miss
    // path returns `info` directly to the middleware, which assigns it to
    // req.auth; without this copy a downstream mutation of that first response
    // would rewrite the cached entry every later request is served from.
    this.tokenCache.set(tokenHash, {
      info: {
        ...info,
        scopes: [...info.scopes],
        allowedSources: info.allowedSources ? [...info.allowedSources] : info.allowedSources,
      },
      notAfterMs,
    });
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    if (this.dcrDisabled) {
      // Surface getClient only — without registerClient the SDK's mcpAuthRouter
      // does not wire up the /register DCR endpoint. Replaces the prior
      // monkey-patch in serve-http.ts; the outcome is identical (DCR off-by-
      // default), but the API expresses intent on the constructor instead of
      // requiring callers to mutate `_clientsStore` after construction.
      return {
        getClient: this._clientsStore.getClient.bind(this._clientsStore),
      } as OAuthRegisteredClientsStore;
    }
    return this._clientsStore;
  }

  // -------------------------------------------------------------------------
  // Authorization Code Flow
  // -------------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = generateToken('gbrain_code_');
    const codeHash = hashToken(code);
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minute TTL

    // Scope clamp (RFC 6749 §3.3): the SDK's authorize handler splits
    // `?scope=...` verbatim and forwards the raw list to the provider, so
    // the provider MUST clamp against the client's registered grant. Without
    // this, a `read`-registered client requesting `?scope=admin` would have
    // `['admin']` stored in oauth_codes and returned by exchangeAuthorizationCode
    // as a fully-admin access token. Mirrors the filter pattern already used
    // by exchangeClientCredentials (this file) and exchangeRefreshToken's F3
    // subset enforcement (RFC 6749 §6) so all three grant entry points clamp
    // consistently. When the client requests NO scope, RFC 6749 §3.3 lets the
    // server fall back to a default — we default to the client's full
    // registered scope (matching exchangeClientCredentials, which already does
    // `requestedScope ? ... : allowedScopes`). Previously an omitted request
    // granted the empty set, which then propagated into the access+refresh
    // tokens and never self-healed: every op failed `insufficient_scope` even
    // though the client was registered with `read write`. Clients that omit
    // `scope` on /authorize (e.g. some MCP connectors) hit this. Still clamped
    // to the allowed set, so an explicit over-broad request can't escalate.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes = (params.scopes && params.scopes.length) ? params.scopes : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => hasScope(allowedScopes, s));

    await this.sql`
      INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                code_challenge_method, redirect_uri, state, resource, expires_at)
      VALUES (${codeHash}, ${client.client_id},
              ${pgArray(grantedScopes)},
              ${params.codeChallenge}, ${'S256'},
              ${params.redirectUri}, ${params.state || null},
              ${params.resource?.toString() || null}, ${expiresAt})
    `;

    // Redirect back with the code
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) redirectUrl.searchParams.set('state', params.state);
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeHash = hashToken(authorizationCode);
    // F1 hardening: bind client_id atomically so a wrong client cannot read
    // another client's PKCE challenge. Pre-fix the SELECT didn't filter on
    // client_id at all.
    const rows = await this.sql`
      SELECT code_challenge FROM oauth_codes
      WHERE code_hash = ${codeHash}
        AND client_id = ${client.client_id}
        AND expires_at > ${Math.floor(Date.now() / 1000)}
    `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');
    return rows[0].code_challenge as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashToken(authorizationCode);
    const now = Math.floor(Date.now() / 1000);

    // F1 + F7c hardening: bind client_id AND redirect_uri atomically into the
    // DELETE WHERE clause. RFC 6749 §10.5 requires auth codes be single-use;
    // RFC 6749 §4.1.3 requires the token endpoint validate redirect_uri
    // matches the value sent at /authorize. The previous SELECT-then-compare
    // pattern (a) burned the code on the wrong-client path so the legitimate
    // client could not retry, and (b) ignored redirect_uri on exchange
    // entirely. With RETURNING, the second request — or any wrong-client /
    // wrong-redirect-uri attempt — gets zero rows back and fails cleanly.
    // The legitimate client's code stays available for one valid redemption.
    //
    // Use `redirectUri !== undefined` rather than truthy — an attacker
    // submitting `redirect_uri=""` (empty string) at /token would otherwise
    // hit the falsy branch and bypass the binding entirely.
    const rows = redirectUri !== undefined
      ? await this.sql`
          DELETE FROM oauth_codes
          WHERE code_hash = ${codeHash}
            AND client_id = ${client.client_id}
            AND redirect_uri = ${redirectUri}
            AND expires_at > ${now}
          RETURNING client_id, scopes, resource
        `
      : await this.sql`
          DELETE FROM oauth_codes
          WHERE code_hash = ${codeHash}
            AND client_id = ${client.client_id}
            AND expires_at > ${now}
          RETURNING client_id, scopes, resource
        `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');

    const codeRow = rows[0];

    // Issue tokens
    const scopes = (codeRow.scopes as string[]) || [];
    return this.issueTokens(client.client_id, scopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Refresh Token
  // -------------------------------------------------------------------------

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);

    // F2 hardening: bind client_id atomically into the DELETE WHERE clause.
    // RFC 6749 §10.4 detection of stolen refresh tokens depends on second-use
    // failure. The previous SELECT-then-DELETE pattern + post-hoc client
    // compare let an attacker who guessed/stole a refresh token burn it on
    // the wrong-client path, defeating the stolen-token signal for the
    // legitimate client. With the predicate in the DELETE, wrong-client
    // attempts get zero rows back; the legitimate client retains the row
    // for one valid rotation.
    const rows = await this.sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash}
        AND token_type = 'refresh'
        AND client_id = ${client.client_id}
      RETURNING client_id, scopes, expires_at
    `;
    if (rows.length === 0) throw new Error('Refresh token not found');

    const row = rows[0];
    // NULL expires_at is treated as expired (fail-closed). Schema permits NULL
    // even though issueTokens always sets it, so a corrupt or hand-modified row
    // can't ride past validation.
    const expiresAt = coerceTimestamp(row.expires_at);
    if (expiresAt === undefined || expiresAt < now) throw new Error('Refresh token expired');

    // F3 hardening: requested scopes on refresh MUST be a subset of the
    // original grant on this refresh token's row. RFC 6749 §6: "the scope of
    // the access token … MUST NOT include any scope not originally granted by
    // the resource owner." Scope is checked against the row's scopes (the
    // grant), NOT against the client's currently-allowed scopes (which can
    // expand later). Omitted scope (`undefined`) inherits the original grant
    // verbatim and stays distinct from an explicit empty array.
    //
    // v0.28: hasScope replaces exact-string-match so an `admin` grant CAN
    // refresh down to `sources_admin` (admin implies all). Without this,
    // gstack /setup-gbrain Path 4 — which mints a sources_admin-scoped
    // refresh — would fail when the brain admin's bootstrap token was
    // issued at the `admin` tier.
    const grantedScopes = (row.scopes as string[]) || [];
    if (scopes && scopes.some(s => !hasScope(grantedScopes, s))) {
      throw new Error('Requested scope exceeds refresh token grant');
    }
    const tokenScopes = scopes ?? grantedScopes;
    return this.issueTokens(client.client_id, tokenScopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Token Verification
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<SdkAuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    // Negative fast path. A token we just proved does not exist gets the same
    // answer without another pool read — the 401 path was measured as the
    // server's most expensive request precisely because it always hit Postgres.
    // Bounded by DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS so a token minted moments
    // ago is rejected for seconds, not for the positive memo's lifetime.
    if (this.isNegativeCached(tokenHash)) {
      throw new InvalidTokenError('Invalid token');
    }

    // Memo fast path (2026-07-27). The shared loopback token is a static
    // secret backed by ONE legacy access_tokens row, so every POST /mcp —
    // including the `initialize` handshake — was re-reading the same two rows.
    // Under host CPU saturation those reads time out (not because the queries
    // are slow, but because the process can't drain its sockets), the bounded
    // read throws AuthDbTimeoutError → 503, and Claude Code abandons tool
    // discovery for the whole session. Serving a repeat verification from
    // memory removes the handshake's database dependency entirely.
    //
    // Only successes land here, so every failure path below — InvalidTokenError,
    // AuthDbTimeoutError, and the isUndefinedColumnError column probes —
    // behaves exactly as it did before.
    const cached = this.getCachedAuth(tokenHash);
    if (cached) return cached as SdkAuthInfo;

    // Try OAuth tokens first. JOIN oauth_clients in the same query so
    // verifyAccessToken returns client_name AND source_id in AuthInfo —
    // eliminates the separate per-request lookup at serve-http.ts that
    // was the N+1 hot path (see PR #586 review D14=B; v0.34.1 #861 D2
    // adds the source_id thread on the same JOIN).
    //
    // v0.34.1 (#861): the JOIN guards on a c.source_id column that
    // migration v60 adds. Pre-v60 brains throw a "column does not exist"
    // error here — caught at the boundary via isUndefinedColumnError so
    // unmigrated brains degrade to "no source scope" rather than refusing
    // every token verification.
    let oauthRows: Record<string, unknown>[];
    try {
      // Bounded + retry-once so a hung read fails fast (~2×timeout) instead of
      // holding the client's MCP `initialize` connect window for the full
      // ~10s driver timeout under DB pressure. A genuine undefined-column
      // error still propagates unchanged into the catch below (non-timeout →
      // not retried), preserving the pre-v60/v61 column-probe fallbacks.
      oauthRows = await readWithAuthDbTimeout(() => this.sql`
        SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name,
               c.source_id, c.federated_read
        FROM oauth_tokens t
        LEFT JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
      `, this.authDbTimeoutMs);
    } catch (err) {
      // v0.34.1: pre-v60 brain → source_id column missing. Pre-v61 brain →
      // federated_read column missing. Both classes degrade to legacy
      // projection so auth keeps working until the operator runs
      // apply-migrations. Probe both column names so partial-upgrade brains
      // (v60 applied but v61 didn't yet) also fall through cleanly.
      if (isUndefinedColumnError(err, 'source_id') || isUndefinedColumnError(err, 'federated_read')) {
        // Try the v60-only projection first (source_id but no federated_read).
        try {
          oauthRows = await this.sql`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.source_id
            FROM oauth_tokens t
            LEFT JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          `;
        } catch (err2) {
          if (isUndefinedColumnError(err2, 'source_id')) {
            // Truly pre-v60: no source_id either. Pre-v0.34 projection.
            oauthRows = await this.sql`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
            `;
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }

    if (oauthRows.length > 0) {
      const row = oauthRows[0];
      // NULL expires_at is treated as expired (fail-closed). Schema permits NULL,
      // and the SDK's bearerAuth requires `typeof expiresAt === 'number'` — we
      // throw here rather than return an undefined-bearing AuthInfo.
      const expiresAt = coerceTimestamp(row.expires_at);
      if (expiresAt === undefined || expiresAt < now) {
        throw new InvalidTokenError('Token expired');
      }
      // v0.34.1 (#876): federated_read normalization. SELECT returns
      // either a JS array (Postgres / PGLite text[] driver mapping) or
      // undefined when the legacy projection ran (pre-v61 brain). Empty
      // array vs undefined matters: empty array = explicit no-federated-
      // read; undefined = column missing on this brain.
      const federatedRaw = row.federated_read;
      const allowedSources = Array.isArray(federatedRaw)
        ? (federatedRaw as string[])
        : undefined;
      const info: CoreAuthInfo = {
        token,
        clientId: row.client_id as string,
        clientName: (row.client_name as string | null) ?? undefined,
        scopes: (row.scopes as string[]) || [],
        expiresAt,
        resource: row.resource ? new URL(row.resource as string) : undefined,
        // v0.34.1 (#861, D2): source-isolation scope from oauth_clients.
        // Undefined when the row predates v60 or when the brain itself
        // predates v60 (fell through to the legacy projection above).
        sourceId: (row.source_id as string | null) ?? undefined,
        // v0.34.1 (#876): federated read scope. sourceScopeOpts in
        // operations.ts prefers this array over scalar sourceId when set
        // and non-empty.
        allowedSources,
      } as CoreAuthInfo;
      // Clamped to the token's own expiry inside setCachedAuth.
      this.setCachedAuth(tokenHash, info);
      return info as SdkAuthInfo;
    }

    // Fallback: legacy access_tokens table (backward compat). Modern legacy
    // rows may carry permissions.source_id from the pre-OAuth bearer-token
    // path; OAuth transport must preserve that same source grant instead of
    // pinning every legacy token to `default`.
    let legacyRows: Record<string, unknown>[];
    try {
      legacyRows = await readWithAuthDbTimeout(() => this.sql`
        SELECT name, permissions FROM access_tokens
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
      `, this.authDbTimeoutMs);
    } catch (err) {
      if (isUndefinedColumnError(err, 'permissions')) {
        legacyRows = await this.sql`
          SELECT name FROM access_tokens
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        `;
      } else {
        throw err;
      }
    }

    if (legacyRows.length > 0) {
      // Legacy tokens get full admin access (grandfather in).
      // For legacy tokens, name = clientId = clientName (single identifier).
      //
      // last_used_at refresh — debounced + fire-and-forget (2026-07-13 wedge).
      // This is soft telemetry and MUST NOT gate the auth decision. The shared
      // static loopback token (~/.gbrain/http-mcp-token) is a legacy
      // access_tokens row (oauth_tokens is empty), so EVERY POST /mcp from every
      // consumer reaches this branch. The prior blocking, un-debounced
      // `await UPDATE ... WHERE token_hash` targeted that SINGLE hot row, so all
      // concurrent requests serialized on one row-write lock; under commit
      // pressure the lock was held across each slow commit and the whole /mcp
      // auth gate hung zero-byte — while /health (SELECT 1, no row lock) stayed
      // fast. That is the exact wedge signature the auth-503 read-bounding fix
      // (readWithAuthDbTimeout) did NOT cover: the hang was in this WRITE, after
      // the bounded reads. The 60s debounce makes ~every call a no-op UPDATE
      // (predicate fails → no row write, no WAL, no lock convoy), and
      // `void … .catch()` removes it from the awaited critical path entirely.
      // Mirrors the legacy transport's identical treatment of this same column
      // (src/mcp/http-transport.ts). readWithAuthDbTimeout is deliberately NOT
      // reused here — it is a READ helper (Promise.race abandons but cannot
      // cancel the query); the right fix for a soft-telemetry write is to never
      // block on it.
      void this.sql`
        UPDATE access_tokens SET last_used_at = now()
        WHERE token_hash = ${tokenHash}
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')
      `.catch(() => { /* best-effort telemetry; never fail auth on it */ });
      const name = legacyRows[0].name as string;
      const permissionsRaw = legacyRows[0].permissions;
      let permissions: unknown = permissionsRaw;
      if (typeof permissionsRaw === 'string') {
        try {
          permissions = JSON.parse(permissionsRaw);
        } catch {
          permissions = undefined;
        }
      }
      const sourceGrant = permissions && typeof permissions === 'object'
        ? (permissions as Record<string, unknown>).source_id
        : undefined;
      const { sourceId, allowedSources } = parseLegacyTokenScope(sourceGrant);
      const info: CoreAuthInfo = {
        token,
        clientId: name,
        clientName: name,
        scopes: ['read', 'write', 'admin'],
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // Legacy tokens never expire — set 1yr future
        // Legacy tokens without an explicit permissions.source_id grant keep
        // the historical 'default' source floor. Array grants become
        // allowedSources for federated reads, matching legacy HTTP transport.
        sourceId,
        allowedSources,
      } as CoreAuthInfo;
      // THE hot path: this is the branch the shared static loopback token takes
      // on every POST /mcp. Memoizing it is what takes Postgres off `initialize`.
      // The 1yr synthetic expiry means the memo TTL is always the binding limit
      // here, so an out-of-process `gbrain auth revoke` is picked up within it.
      this.setCachedAuth(tokenHash, info);
      return info as SdkAuthInfo;
    }

    // Reached ONLY when both reads succeeded and returned no rows — a
    // definitive not-found. Every transient failure (AuthDbTimeoutError, the
    // undefined-column probes) throws before here, so nothing infrastructural
    // can be memoized as "invalid".
    this.setNegativeCached(tokenHash);
    throw new InvalidTokenError('Invalid token');
  }

  // -------------------------------------------------------------------------
  // Token Revocation
  // -------------------------------------------------------------------------

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);
    // F4 hardening: bind client_id so a client can only revoke its own
    // tokens. RFC 7009 §2.1: "The authorization server first validates the
    // client credentials … and then verifies whether the token was issued
    // to the client making the revocation request." Pre-fix, any
    // authenticated client that knew (or guessed) another client's token
    // hash could revoke it.
    await this.sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash}
        AND client_id = ${client.client_id}
    `;
    // Evict the memo so the revocation takes effect on the very next request
    // rather than after the TTL lapses.
    this.invalidateTokenHash(tokenHash);
  }

  // -------------------------------------------------------------------------
  // Client Credentials (called by custom handler, not SDK)
  // -------------------------------------------------------------------------

  /**
   * v0.37.7.0 #1166 — verify a confidential client's secret without
   * spending it. Returns the validated client info on success, throws
   * with an opaque "Invalid client" message on failure (mirrors RFC 6749
   * §5.2 invalid_client semantics). Used by the serve-http custom
   * /token handler for `authorization_code` + `refresh_token` grants on
   * confidential clients, since the SDK's plaintext compare in
   * clientAuth.js can't see our hash-only storage.
   *
   * Public clients (token_endpoint_auth_method === 'none') return
   * `client_secret_hash = NULL` from getClient; this method refuses
   * them so the SDK's PKCE path stays the canonical surface.
   */
  async verifyConfidentialClientSecret(
    clientId: string,
    presentedSecret: string,
  ): Promise<OAuthClientInformationFull> {
    const client = await this._clientsStore.getClient(clientId);
    if (!client) throw new Error('Invalid client');
    // Public client — refuse to use this hash-compare path.
    if (client.client_secret === undefined) {
      throw new Error('Invalid client');
    }
    const presentedHash = hashToken(presentedSecret);
    // client.client_secret is the stored SHA-256 hash (getClient returns
    // it as the `client_secret` field per the v0.34.1.0 normalization).
    // Compare via SHA-256-then-equals; constant-time compare a follow-up.
    if (client.client_secret !== presentedHash) {
      throw new Error('Invalid client');
    }
    // Soft-delete probe — same shape as exchangeClientCredentials.
    try {
      const [revoked] = await this.sql`SELECT deleted_at FROM oauth_clients WHERE client_id = ${clientId} AND deleted_at IS NOT NULL`;
      if (revoked) throw new Error('Client has been revoked');
    } catch (e) {
      if (e instanceof Error && e.message === 'Client has been revoked') throw e;
      if (!isUndefinedColumnError(e, 'deleted_at')) throw e;
    }
    return client;
  }

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
  ): Promise<OAuthTokens> {
    const client = await this._clientsStore.getClient(clientId);
    if (!client) throw new Error('Client not found');

    // Check if client has been revoked (soft-deleted). The deleted_at column
    // is recent — pre-migration brains don't have it, so the probe must
    // tolerate that one specific failure mode without swallowing real errors
    // (lock timeouts, network blips, auth failures).
    try {
      const [revoked] = await this.sql`SELECT deleted_at FROM oauth_clients WHERE client_id = ${clientId} AND deleted_at IS NOT NULL`;
      if (revoked) throw new Error('Client has been revoked');
    } catch (e) {
      // F5 hardening: surface anything that ISN'T a missing-column error.
      // Bare `catch {}` masked DB outages as "client not revoked" — fail-open
      // posture in a security-sensitive code path.
      if (e instanceof Error && e.message === 'Client has been revoked') throw e;
      if (!isUndefinedColumnError(e, 'deleted_at')) throw e;
    }

    // Check grant type first (before verifying secret)
    const grants = (client.grant_types as string[]) || [];
    if (!grants.includes('client_credentials')) {
      throw new Error('Client credentials grant not authorized for this client');
    }

    // Verify secret
    const secretHash = hashToken(clientSecret);
    if (client.client_secret !== secretHash) throw new Error('Invalid client secret');

    // Determine scopes. v0.28 swaps exact-string-match for hasScope so a
    // client whose grant is `admin` can mint tokens that include implied
    // scopes like `sources_admin` (admin implies all). Tokens are still
    // capped by what the client was registered for — this only changes how
    // the cap is computed.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes = requestedScope ? parseScopeString(requestedScope) : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => hasScope(allowedScopes, s));

    // Per-client TTL override (stored in oauth_clients.token_ttl)
    // Column may not exist on PGLite/older schemas — graceful fallback
    let clientTtl: number | undefined;
    try {
      const ttlRows = await this.sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${clientId}`;
      if (ttlRows.length > 0 && ttlRows[0].token_ttl) clientTtl = Number(ttlRows[0].token_ttl);
    } catch (e) {
      // F5 hardening: same posture as the deleted_at probe above. Only the
      // "column doesn't exist" path is a non-fatal fall-through.
      if (!isUndefinedColumnError(e, 'token_ttl')) throw e;
    }

    // Client credentials: access token only, NO refresh token (RFC 6749 4.4.3)
    return this.issueTokens(clientId, grantedScopes, undefined, false, clientTtl);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async sweepExpiredTokens(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    // F6 hardening: postgres.js and PGLite expose deleted-row count on
    // different shapes; `(result as any).count` returned 0 on at least one
    // engine even when rows were deleted, and codes were never counted at
    // all. RETURNING 1 + array length is portable across both engines.
    const result = await this.sql`
      DELETE FROM oauth_tokens WHERE expires_at < ${now} RETURNING 1
    `;
    const deletedCodes = await this.sql`
      DELETE FROM oauth_codes WHERE expires_at < ${now} RETURNING 1
    `;
    return result.length + deletedCodes.length;
  }

  // -------------------------------------------------------------------------
  // CLI Registration Helper
  // -------------------------------------------------------------------------

  async registerClientManual(
    name: string,
    grantTypes: string[],
    scopes: string,
    redirectUris: string[] = [],
    sourceId: string = 'default',
    federatedRead?: string[],
    tokenEndpointAuthMethod?: string,
    agentBindings?: AgentClientBindings,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    // v0.28: ALLOWED_SCOPES allowlist. Reject `--scopes "read flying-unicorn"`
    // at registration so meaningless scope strings can't pile up in the DB.
    // Pre-allowlist clients keep working (allowlist is registration-time;
    // existing rows aren't re-validated).
    assertAllowedScopes(parseScopeString(scopes));

    // v0.41.3 (T1+T2): validate token_endpoint_auth_method at the registration
    // boundary. Throws InvalidTokenEndpointAuthMethodError on bad input.
    // Default is `client_secret_post` (RFC 7591 §2).
    const authMethod = validateTokenEndpointAuthMethod(tokenEndpointAuthMethod);

    const clientId = generateToken('gbrain_cl_');
    // v0.41.3 (T2): atomic public-client INSERT. When the caller declares
    // `tokenEndpointAuthMethod: 'none'` we mint NO secret and INSERT with
    // client_secret_hash = NULL in a single statement. Pre-fix, the admin
    // endpoint did INSERT-then-UPDATE which left a confidential row stranded
    // if the UPDATE failed mid-flight (codex F4). Confidential clients
    // (`client_secret_post` / `client_secret_basic`) get the secret minted
    // and hashed as before.
    const isPublicClient = authMethod === 'none';
    const clientSecret = isPublicClient ? undefined : generateToken('gbrain_cs_');
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    // v0.34.1 (#861 + #876): persist source_id AND federated_read so
    // verifyAccessToken can populate both AuthInfo fields. Defaults:
    //   source_id = 'default' (matches v60 backfill)
    //   federated_read = [source_id] when omitted (a non-federated client
    //                    has read scope == write scope, the v0.33 default)
    const federated = federatedRead && federatedRead.length > 0 ? federatedRead : [sourceId];
    try {
      if (agentBindings) {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at,
                                      source_id, federated_read,
                                      bound_tools, bound_source_id, bound_brain_id,
                                      bound_slug_prefixes, bound_max_concurrent, budget_usd_per_day)
          VALUES (${clientId}, ${secretHash}, ${name},
                  ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now},
                  ${sourceId}, ${pgArray(federated)},
                  ${agentBindings.boundTools ? pgArray(agentBindings.boundTools) : null},
                  ${agentBindings.boundSourceId ?? null}, ${agentBindings.boundBrainId ?? null},
                  ${agentBindings.boundSlugPrefixes ? pgArray(agentBindings.boundSlugPrefixes) : null},
                  ${agentBindings.boundMaxConcurrent ?? 1}, ${agentBindings.budgetUsdPerDay ?? null})
        `;
      } else {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at,
                                      source_id, federated_read)
          VALUES (${clientId}, ${secretHash}, ${name},
                  ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now},
                  ${sourceId}, ${pgArray(federated)})
        `;
      }
    } catch (err) {
      if (agentBindings && (
        isUndefinedColumnError(err, 'bound_tools') ||
        isUndefinedColumnError(err, 'bound_source_id') ||
        isUndefinedColumnError(err, 'bound_brain_id') ||
        isUndefinedColumnError(err, 'bound_slug_prefixes') ||
        isUndefinedColumnError(err, 'bound_max_concurrent') ||
        isUndefinedColumnError(err, 'budget_usd_per_day')
      )) {
        throw new Error('register-client --bound-* flags require an up-to-date OAuth schema; run `gbrain apply-migrations --yes` and retry.');
      }
      // Pre-v60 / pre-v61 brain: column missing. Fall back through both
      // projections so registration still works until apply-migrations.
      if (isUndefinedColumnError(err, 'federated_read')) {
        // v60-only brain: source_id but no federated_read.
        try {
          await this.sql`
            INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                        grant_types, scope, token_endpoint_auth_method,
                                        client_id_issued_at, source_id)
            VALUES (${clientId}, ${secretHash}, ${name},
                    ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now}, ${sourceId})
          `;
        } catch (err2) {
          if (isUndefinedColumnError(err2, 'source_id')) {
            await this.sql`
              INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                          grant_types, scope, token_endpoint_auth_method,
                                          client_id_issued_at)
              VALUES (${clientId}, ${secretHash}, ${name},
                      ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now})
            `;
          } else {
            throw err2;
          }
        }
      } else if (isUndefinedColumnError(err, 'source_id')) {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at)
          VALUES (${clientId}, ${secretHash}, ${name},
                  ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now})
        `;
      } else {
        throw err;
      }
    }

    return { clientId, clientSecret };
  }

  /**
   * v0.42.x (#1914): admin-gated rescope for an existing OAuth client.
   *
   * DCR clients self-register with source_id='default' +
   * federated_read=['default'] and MUST NOT be able to widen their own
   * scope (fail-closed trust). This is the trusted-operator surface that
   * changes it afterward: `gbrain auth rescope-client` (local CLI) and
   * POST /admin/api/rescope-client (requireAdmin) both route here.
   *
   * Omitted fields are left untouched (COALESCE). Takes effect on the
   * client's NEXT request even for already-issued tokens, because
   * verifyAccessToken re-reads oauth_clients on every verification.
   */
  async rescopeClient(
    clientId: string,
    opts: { sourceId?: string; federatedRead?: string[] },
  ): Promise<{ clientId: string; clientName: string; sourceId: string; federatedRead: string[] }> {
    const { sourceId, federatedRead } = opts;
    if (sourceId === undefined && federatedRead === undefined) {
      throw new Error('rescope-client requires --source and/or --federated-read');
    }
    if (sourceId !== undefined) assertValidSourceId(sourceId);
    if (federatedRead !== undefined) {
      if (federatedRead.length === 0) {
        throw new Error('--federated-read cannot be empty (pass at least one source id)');
      }
      for (const s of federatedRead) assertValidSourceId(s);
    }
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql`
        UPDATE oauth_clients
           SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
               federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read)
         WHERE client_id = ${clientId}
         RETURNING client_id, client_name, source_id, federated_read
      `;
    } catch (err) {
      if (isUndefinedColumnError(err, 'source_id') || isUndefinedColumnError(err, 'federated_read')) {
        throw new Error('rescope-client requires an up-to-date OAuth schema; run `gbrain apply-migrations --yes` and retry.');
      }
      // FK oauth_clients.source_id → sources(id): translate the raw 23503
      // into an actionable message.
      if ((err as { code?: string })?.code === '23503') {
        throw new Error(`Source "${sourceId}" does not exist. Create it first: gbrain sources add ${sourceId} ...`);
      }
      throw err;
    }
    if (rows.length === 0) {
      throw new Error(`No OAuth client found with id "${clientId}"`);
    }
    const row = rows[0];
    return {
      clientId: row.client_id as string,
      clientName: (row.client_name as string | null) ?? '',
      sourceId: (row.source_id as string | null) ?? 'default',
      federatedRead: Array.isArray(row.federated_read) ? (row.federated_read as string[]) : [],
    };
  }

  // -------------------------------------------------------------------------
  // Internal: Issue access + optional refresh tokens
  // -------------------------------------------------------------------------

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    includeRefresh: boolean,
    ttlOverride?: number,
  ): Promise<OAuthTokens> {
    const accessToken = generateToken('gbrain_at_');
    const accessHash = hashToken(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const effectiveTtl = ttlOverride || this.tokenTtl;
    const accessExpiry = now + effectiveTtl;

    await this.sql`
      INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
      VALUES (${accessHash}, ${'access'}, ${clientId},
              ${pgArray(scopes)}, ${accessExpiry}, ${resource?.toString() || null})
    `;

    const result: OAuthTokens = {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: effectiveTtl,
      scope: scopes.join(' '),
    };

    if (includeRefresh) {
      const refreshToken = generateToken('gbrain_rt_');
      const refreshHash = hashToken(refreshToken);
      const refreshExpiry = now + this.refreshTtl;

      await this.sql`
        INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
        VALUES (${refreshHash}, ${'refresh'}, ${clientId},
                ${pgArray(scopes)}, ${refreshExpiry}, ${resource?.toString() || null})
      `;

      result.refresh_token = refreshToken;
    }

    return result;
  }
}
