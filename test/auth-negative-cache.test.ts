import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS,
  resolveAuthNegativeCacheTtlMs,
  DEFAULT_AUTH_CACHE_TTL_MS,
} from '../src/core/oauth-provider.ts';

/**
 * Regression: an INVALID bearer token was the most expensive request the
 * :7483 server served.
 *
 * Measured 2026-08-12 (v0.42.90.0), interleaved in one window so host load is
 * shared across the three paths:
 *
 *   static (no auth, no DB) : 0.09 / 0.34 / 0.47 / 0.79 s
 *   bad token -> 401        : 9.07 / 13.40 / 22.17 / 27.21 s
 *   good token -> 200 (66KB): 0.32 / 0.86 / 1.55 / 4.04 s
 *
 * The 401 path builds no payload, writes no audit row and serializes nothing.
 * It is slowest precisely BECAUSE it is the only one that always reaches
 * Postgres: `verifyAccessToken` memoizes successes only, so every failure
 * re-pays a real pool read (~0.15-2.14s just to open a backend when the pool
 * has gone cold, before the 0.069ms query).
 *
 * That turns a client with a stale token into a self-amplifying load source —
 * the same shape as the retry-on-503 loop recorded in the large-page-write
 * starvation incident, where each failure made the server busier and so made
 * the next failure likelier.
 *
 * The negative memo must stay SHORT. The positive memo's docstring gives the
 * reason failures were excluded in the first place: "a token minted a moment
 * ago must not be rejected for the rest of the TTL". A few seconds collapses a
 * retry storm while bounding that mint race to something a human never notices.
 */
describe('auth negative cache TTL', () => {
  it('is far shorter than the positive memo', () => {
    // The asymmetry IS the design. A negative entry denies service, so it gets
    // orders of magnitude less trust than a positive one.
    expect(DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS).toBeGreaterThan(0);
    expect(DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS).toBeLessThan(DEFAULT_AUTH_CACHE_TTL_MS);
  });

  it('bounds the mint race to a few seconds at most', () => {
    // A token created between a 401 and the client's retry is rejected for at
    // most this long. Keep it small enough that no human notices and no sane
    // retry loop is defeated.
    expect(DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS).toBeLessThanOrEqual(5_000);
  });

  it('honours GBRAIN_AUTH_NEGATIVE_CACHE_TTL_MS, and 0 is the off switch', () => {
    expect(resolveAuthNegativeCacheTtlMs('1500')).toBe(1500);
    // 0 must survive as 0 — it is the operator's opt-out, not a bad value to
    // be coerced back to the default.
    expect(resolveAuthNegativeCacheTtlMs('0')).toBe(0);
  });

  it('falls back to the default on unset or unparseable input', () => {
    expect(resolveAuthNegativeCacheTtlMs(undefined)).toBe(DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS);
    expect(resolveAuthNegativeCacheTtlMs('')).toBe(DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS);
    expect(resolveAuthNegativeCacheTtlMs('nonsense')).toBe(DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS);
    expect(resolveAuthNegativeCacheTtlMs('-5')).toBe(DEFAULT_AUTH_NEGATIVE_CACHE_TTL_MS);
  });
});
