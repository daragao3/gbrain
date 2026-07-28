/**
 * In-process memoization of verifyAccessToken (2026-07-27 MCP registration failure).
 *
 * Root cause: every POST /mcp — INCLUDING the MCP `initialize` handshake — is
 * gated by requireBearerAuthRetryable → verifyAccessToken, which does TWO
 * Postgres reads (oauth_tokens LEFT JOIN oauth_clients, then access_tokens).
 * Each is bounded by readWithAuthDbTimeout; a double miss throws
 * AuthDbTimeoutError → HTTP 503. Claude Code does NOT retry a 503 on
 * `initialize`, so the session registers ZERO mcp__gbrain__* tools while the
 * server still reports "Connected" and /health returns 200.
 *
 * No timeout value fixes this: the queries are ~0.05ms (EXPLAIN ANALYZE) and
 * during a stall pg_stat_activity shows every backend idle/ClientRead — Postgres
 * has already answered and is waiting on a client that isn't draining its
 * sockets, because the host runs ~1500 processes at 100% CPU. The failure
 * signature just walks with the bound (13s@2500 → 19s@6000 → 29s@15000).
 *
 * The shared loopback token (~/.gbrain/http-mcp-token) is a STATIC secret on
 * disk stored as a single legacy access_tokens row. Verifying it does not need
 * a database round trip on every request. These tests pin that the memo serves
 * repeat verifications from memory WITHOUT regressing auth correctness.
 */
import { describe, test, expect } from 'bun:test';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  GBrainOAuthProvider,
  resolveAuthCacheTtlMs,
  DEFAULT_AUTH_CACHE_TTL_MS,
  AuthDbTimeoutError,
} from '../src/core/oauth-provider.ts';
import type { SqlQuery } from '../src/core/sql-query.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface MockOpts {
  /** Rows returned for the oauth_tokens SELECT. Default [] (miss, as in prod). */
  oauthRows?: () => Record<string, unknown>[];
  /** Rows returned for the access_tokens SELECT. Default one legacy row. */
  legacyRows?: () => Record<string, unknown>[];
  /**
   * Full control of the oauth_tokens branch — return the promise the driver
   * would hand back. Lets a test express "hangs forever" (never-settling
   * promise) or "fails only on the widest projection" (reject once, then
   * resolve), neither of which a plain throw-value can model.
   */
  onOauth?: () => Promise<Record<string, unknown>[]>;
}

/**
 * Mock SqlQuery routing by query shape, capturing every executed query text.
 * Mirrors the idiom in test/oauth-legacy-last-used-nonblocking.test.ts.
 */
function mockSql(capture: string[], opts: MockOpts = {}): SqlQuery {
  return ((strings: TemplateStringsArray) => {
    const q = strings.join('?');
    capture.push(q);
    if (/UPDATE\s+access_tokens\s+SET\s+last_used_at/i.test(q)) {
      return Promise.resolve([]);
    }
    if (/FROM\s+oauth_tokens/i.test(q)) {
      if (opts.onOauth) return opts.onOauth();
      return Promise.resolve(opts.oauthRows ? opts.oauthRows() : []);
    }
    if (/FROM\s+access_tokens/i.test(q)) {
      return Promise.resolve(
        opts.legacyRows
          ? opts.legacyRows()
          : [{ name: 'shared-http-loopback', permissions: null }],
      );
    }
    return Promise.resolve([]);
  }) as SqlQuery;
}

/** Query texts that represent an actual token-lookup READ (not the telemetry UPDATE). */
const reads = (capture: string[]) =>
  capture.filter(q => /FROM\s+(oauth_tokens|access_tokens)/i.test(q));

const updates = (capture: string[]) =>
  capture.filter(q => /UPDATE\s+access_tokens\s+SET\s+last_used_at/i.test(q));

describe('resolveAuthCacheTtlMs', () => {
  test('defaults when unset or invalid', () => {
    expect(resolveAuthCacheTtlMs(undefined)).toBe(DEFAULT_AUTH_CACHE_TTL_MS);
    expect(resolveAuthCacheTtlMs('')).toBe(DEFAULT_AUTH_CACHE_TTL_MS);
    expect(resolveAuthCacheTtlMs('-5')).toBe(DEFAULT_AUTH_CACHE_TTL_MS);
    expect(resolveAuthCacheTtlMs('abc')).toBe(DEFAULT_AUTH_CACHE_TTL_MS);
  });

  test('honors a valid override', () => {
    expect(resolveAuthCacheTtlMs('60000')).toBe(60000);
  });

  test('accepts 0 as an explicit disable (NOT coerced to the default)', () => {
    // 0 must survive: it is the operator's off-switch for the memo.
    expect(resolveAuthCacheTtlMs('0')).toBe(0);
  });
});

describe('verifyAccessToken memoization — the hot path', () => {
  test('a repeat verification of the same token issues ZERO database reads', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({ sql: mockSql(captured) });

    await provider.verifyAccessToken('static-loopback-token');
    const afterFirst = reads(captured).length;
    expect(afterFirst).toBeGreaterThan(0); // the miss really did read

    await provider.verifyAccessToken('static-loopback-token');

    // This is the whole fix: the second handshake never touches Postgres.
    expect(reads(captured).length).toBe(afterFirst);
  });

  test('the cached AuthInfo carries the same identity and scopes as the DB read', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({ sql: mockSql(captured) });

    const first = await provider.verifyAccessToken('static-loopback-token');
    const second = await provider.verifyAccessToken('static-loopback-token');

    expect(second.clientId).toBe(first.clientId);
    // clientName is a gbrain extension on CoreAuthInfo, not on the SDK's AuthInfo.
    expect((second as { clientName?: string }).clientName)
      .toBe((first as { clientName?: string }).clientName);
    expect(second.scopes).toEqual(first.scopes);
    expect(second.token).toBe('static-loopback-token');
  });

  test('a DIFFERENT token is never served from another token\'s entry', async () => {
    const captured: string[] = [];
    let which = 'a';
    const provider = new GBrainOAuthProvider({
      sql: mockSql(captured, {
        legacyRows: () => [{ name: `client-${which}`, permissions: null }],
      }),
    });

    const a = await provider.verifyAccessToken('token-a');
    which = 'b';
    const b = await provider.verifyAccessToken('token-b');

    expect(a.clientId).toBe('client-a');
    expect(b.clientId).toBe('client-b'); // read fresh, not served from 'a'
  });

  test('the returned object is a copy — mutating it cannot contaminate the next hit', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({ sql: mockSql(captured) });

    const first = await provider.verifyAccessToken('static-loopback-token');
    // Downstream sets req.auth = authInfo; a mutation there must not leak.
    first.scopes.push('smuggled-scope');
    (first as { clientId: string }).clientId = 'smuggled-client';

    const second = await provider.verifyAccessToken('static-loopback-token');
    expect(second.scopes).not.toContain('smuggled-scope');
    expect(second.clientId).toBe('shared-http-loopback');
  });

  test('a cache hit does NOT re-fire the last_used_at telemetry UPDATE', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({ sql: mockSql(captured) });

    await provider.verifyAccessToken('static-loopback-token');
    const afterFirst = updates(captured).length;
    expect(afterFirst).toBe(1); // miss path still fires it, fire-and-forget

    await provider.verifyAccessToken('static-loopback-token');
    expect(updates(captured).length).toBe(afterFirst);
  });
});

describe('verifyAccessToken memoization — TTL', () => {
  test('re-reads the database once the TTL lapses', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({
      sql: mockSql(captured),
      authCacheTtlMs: 25,
    });

    await provider.verifyAccessToken('static-loopback-token');
    const afterFirst = reads(captured).length;

    await provider.verifyAccessToken('static-loopback-token');
    expect(reads(captured).length).toBe(afterFirst); // still inside the TTL

    await sleep(60);
    await provider.verifyAccessToken('static-loopback-token');
    expect(reads(captured).length).toBeGreaterThan(afterFirst); // TTL lapsed → fresh read
  });

  test('ttl 0 disables the memo entirely — every verification reads', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({
      sql: mockSql(captured),
      authCacheTtlMs: 0,
    });

    await provider.verifyAccessToken('static-loopback-token');
    const afterFirst = reads(captured).length;
    await provider.verifyAccessToken('static-loopback-token');

    expect(reads(captured).length).toBeGreaterThan(afterFirst);
  });

  test('an entry never outlives the token\'s own expiry, even with a long TTL', async () => {
    // The OAuth branch carries a real expires_at. A 30s memo TTL must NOT keep
    // a token alive one second past its expiry.
    const captured: string[] = [];
    const expiresAt = Math.floor(Date.now() / 1000) + 1; // expires in ~1s
    const provider = new GBrainOAuthProvider({
      sql: mockSql(captured, {
        oauthRows: () => [{
          client_id: 'oauth-client',
          scopes: ['read'],
          expires_at: expiresAt,
          resource: null,
          client_name: 'OAuth Client',
          source_id: null,
          federated_read: null,
        }],
      }),
      authCacheTtlMs: 30_000, // deliberately far longer than the token's life
    });

    const first = await provider.verifyAccessToken('short-lived-oauth-token');
    expect(first.clientId).toBe('oauth-client');

    // Expiry is compared at SECOND granularity (`expiresAt < now`), exactly as
    // the database path does it, so a token stamped T+1 is still valid THROUGH
    // second T+1. Sleep past the start of T+2 so the assertion is deterministic
    // regardless of where inside second T the test happened to begin.
    await sleep(2300);

    // Must NOT return the stale cached AuthInfo — fail closed.
    await expect(
      provider.verifyAccessToken('short-lived-oauth-token'),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('verifyAccessToken memoization — auth correctness must not regress', () => {
  test('an unknown token still throws InvalidTokenError and is NOT cached', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({
      sql: mockSql(captured, { legacyRows: () => [] }), // both lookups miss
    });

    await expect(provider.verifyAccessToken('bogus')).rejects.toBeInstanceOf(InvalidTokenError);
    const afterFirst = reads(captured).length;

    // A negative result must never be memoized: a token created a moment ago
    // must not be rejected for the rest of the TTL.
    await expect(provider.verifyAccessToken('bogus')).rejects.toBeInstanceOf(InvalidTokenError);
    expect(reads(captured).length).toBeGreaterThan(afterFirst);
  });

  test('AuthDbTimeoutError propagates unchanged and is NOT cached', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({
      sql: mockSql(captured, {
        // Never settles → readWithAuthDbTimeout gives up after its retry.
        onOauth: () => new Promise<Record<string, unknown>[]>(() => {}),
      }),
      authDbTimeoutMs: 15,
    });

    // A hung read must still surface as the transient error the 503 branch keys on.
    await expect(
      provider.verifyAccessToken('static-loopback-token'),
    ).rejects.toBeInstanceOf(AuthDbTimeoutError);
  });

  test('revokeToken drops that token\'s entry so the next verify reads fresh', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({
      sql: mockSql(captured, {
        oauthRows: () => [{
          client_id: 'oauth-client',
          scopes: ['read'],
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          resource: null,
          client_name: 'OAuth Client',
          source_id: null,
          federated_read: null,
        }],
      }),
    });

    await provider.verifyAccessToken('revoke-me');
    const afterFirst = reads(captured).length;

    await provider.revokeToken(
      { client_id: 'oauth-client' } as never,
      { token: 'revoke-me' } as never,
    );

    await provider.verifyAccessToken('revoke-me');
    expect(reads(captured).length).toBeGreaterThan(afterFirst);
  });

  test('clearTokenCache() forces the next verification back to the database', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({ sql: mockSql(captured) });

    await provider.verifyAccessToken('static-loopback-token');
    const afterFirst = reads(captured).length;

    // Wired into the admin revoke-by-name endpoint, which cannot know the hash.
    provider.clearTokenCache();

    await provider.verifyAccessToken('static-loopback-token');
    expect(reads(captured).length).toBeGreaterThan(afterFirst);
  });

  test('the pre-v60 undefined-column fallback still resolves, and its result caches', async () => {
    const captured: string[] = [];
    let attempt = 0;
    const provider = new GBrainOAuthProvider({
      sql: mockSql(captured, {
        onOauth: () => {
          // Only the first (widest) projection fails; the probe fallback then
          // runs the narrower SELECT, which the mock answers with [].
          attempt += 1;
          return attempt === 1
            ? Promise.reject(
                Object.assign(new Error('column "source_id" does not exist'), { code: '42703' }),
              )
            : Promise.resolve([] as Record<string, unknown>[]);
        },
      }),
    });

    const first = await provider.verifyAccessToken('static-loopback-token');
    expect(first.clientId).toBe('shared-http-loopback');
    const afterFirst = reads(captured).length;

    await provider.verifyAccessToken('static-loopback-token');
    expect(reads(captured).length).toBe(afterFirst);
  });
});
