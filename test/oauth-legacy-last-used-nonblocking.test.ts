/**
 * Regression: verifyAccessToken must NOT block the auth decision on the legacy
 * access_tokens `last_used_at` refresh (2026-07-13 evening /mcp zero-byte wedge).
 *
 * The shared static loopback token (~/.gbrain/http-mcp-token) lives in
 * access_tokens (oauth_tokens is empty in this deployment), so EVERY POST /mcp
 * falls through to the legacy branch. The pre-fix code did a blocking
 * `await UPDATE access_tokens SET last_used_at = now() WHERE token_hash = …`
 * against that single hot row — under concurrency + commit pressure every
 * request serialized on one row-write lock and the whole /mcp auth gate hung
 * zero-byte (while /health stayed fast). The fix debounces (60s) and
 * fire-and-forgets the refresh so it never gates auth.
 *
 * These assertions pin: (a) auth resolves without awaiting the refresh even
 * while the refresh is still pending, and (b) the refresh carries the 60s
 * debounce predicate so the single-row write convoy cannot re-form.
 */
import { describe, test, expect } from 'bun:test';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import type { SqlQuery } from '../src/core/sql-query.ts';

/**
 * Mock SqlQuery that routes by query shape:
 *  - oauth_tokens SELECT → [] (primary lookup misses, as in production)
 *  - access_tokens SELECT → one legacy row (token hit)
 *  - access_tokens UPDATE → delegated to `onUpdate` so the test controls timing
 * Every executed query text is pushed into `capture` for assertions.
 */
function mockSql(
  onUpdate: () => Promise<Record<string, unknown>[]>,
  capture: string[],
): SqlQuery {
  return ((strings: TemplateStringsArray) => {
    const q = strings.join('?');
    capture.push(q);
    if (/UPDATE\s+access_tokens\s+SET\s+last_used_at/i.test(q)) {
      return onUpdate();
    }
    if (/FROM\s+oauth_tokens/i.test(q)) {
      return Promise.resolve([] as Record<string, unknown>[]);
    }
    if (/FROM\s+access_tokens/i.test(q)) {
      return Promise.resolve([{ name: 'shared-http-loopback', permissions: null }]);
    }
    return Promise.resolve([] as Record<string, unknown>[]);
  }) as SqlQuery;
}

describe('verifyAccessToken legacy last_used_at refresh is non-blocking', () => {
  test('resolves while the last_used_at UPDATE is still pending (never awaited)', async () => {
    const captured: string[] = [];
    let updateStarted = false;
    let releaseUpdate!: () => void;
    // A manually-gated promise: verifyAccessToken must resolve BEFORE we release
    // it, proving the refresh is not on the awaited path.
    const gate = new Promise<Record<string, unknown>[]>((resolve) => {
      releaseUpdate = () => resolve([]);
    });

    const provider = new GBrainOAuthProvider({
      sql: mockSql(() => {
        updateStarted = true;
        return gate;
      }, captured),
    });

    const info = await provider.verifyAccessToken('any-token');

    // Auth succeeded on the legacy path…
    expect(info.clientId).toBe('shared-http-loopback');
    expect(info.scopes).toEqual(['read', 'write', 'admin']);
    // …the refresh WAS issued…
    expect(updateStarted).toBe(true);
    // …and it is still gated here — verifyAccessToken did not await it.
    expect(captured.some(q => /UPDATE\s+access_tokens\s+SET\s+last_used_at/i.test(q))).toBe(true);

    releaseUpdate(); // avoid a dangling pending promise
  });

  test('the refresh carries the 60-second debounce predicate', async () => {
    const captured: string[] = [];
    const provider = new GBrainOAuthProvider({
      sql: mockSql(() => Promise.resolve([]), captured),
    });

    await provider.verifyAccessToken('any-token');

    const upd = captured.find(q => /UPDATE\s+access_tokens\s+SET\s+last_used_at/i.test(q));
    expect(upd).toBeDefined();
    expect(upd!).toMatch(
      /last_used_at\s+IS\s+NULL\s+OR\s+last_used_at\s*<\s*now\(\)\s*-\s*interval\s*'60 seconds'/i,
    );
  });
});
