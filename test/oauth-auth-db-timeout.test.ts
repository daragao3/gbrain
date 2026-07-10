/**
 * Bounded + retry-once wrapper for verifyAccessToken's token-lookup reads.
 *
 * Regression guard for the 2026-07-10 diagnosis: every POST /mcp — including
 * the MCP `initialize` handshake — is gated by requireBearerAuth →
 * verifyAccessToken, which reads the token row from Postgres. Under DB/commit
 * pressure that read hung ~10s before the driver threw; the raw throw became
 * an SDK ServerError 500, and a 500 on `initialize` made Claude Code abort
 * tool discovery for the whole session (server showed "Connected" but exposed
 * zero tools). readWithAuthDbTimeout bounds each read and retries once on
 * timeout so a momentary blip is absorbed and a real hang fails fast.
 *
 * These cover the four behaviors that matter; the timing assertions use a tiny
 * timeout so the suite stays fast.
 */
import { describe, test, expect } from 'bun:test';
import {
  readWithAuthDbTimeout,
  AuthDbTimeoutError,
  resolveAuthDbTimeoutMs,
  DEFAULT_AUTH_DB_TIMEOUT_MS,
} from '../src/core/oauth-provider.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('readWithAuthDbTimeout', () => {
  test('returns the row on a fast read (happy path)', async () => {
    const rows = [{ client_id: 'c1' }];
    const out = await readWithAuthDbTimeout(async () => rows, 50);
    expect(out).toBe(rows);
  });

  test('retries once on a timeout, then succeeds if the retry is fast', async () => {
    let calls = 0;
    const out = await readWithAuthDbTimeout(async () => {
      calls += 1;
      if (calls === 1) {
        await sleep(50); // first attempt exceeds the 10ms bound → abandoned
        return ['stale'];
      }
      return ['fresh']; // retry answers immediately
    }, 10);
    expect(calls).toBe(2);
    expect(out).toEqual(['fresh']);
  });

  test('throws AuthDbTimeoutError when both attempts time out (fail-fast)', async () => {
    let calls = 0;
    const started = Date.now();
    const p = readWithAuthDbTimeout(async () => {
      calls += 1;
      await sleep(1000); // never answers within the bound
      return ['never'];
    }, 20);
    await expect(p).rejects.toBeInstanceOf(AuthDbTimeoutError);
    expect(calls).toBe(2);
    // ~2×timeout, decisively less than the ~10s driver hang it replaces.
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('propagates a non-timeout rejection UNCHANGED and does NOT retry', async () => {
    // A deterministic error (e.g. undefined-column) must reach the caller's
    // isUndefinedColumnError fallback intact — not retried, not reclassified.
    let calls = 0;
    const columnErr = Object.assign(new Error('column "source_id" does not exist'), {
      code: '42703',
    });
    const p = readWithAuthDbTimeout(async () => {
      calls += 1;
      throw columnErr;
    }, 50);
    await expect(p).rejects.toBe(columnErr);
    expect(calls).toBe(1);
  });
});

describe('resolveAuthDbTimeoutMs', () => {
  test('defaults when unset or invalid', () => {
    expect(resolveAuthDbTimeoutMs(undefined)).toBe(DEFAULT_AUTH_DB_TIMEOUT_MS);
    expect(resolveAuthDbTimeoutMs('')).toBe(DEFAULT_AUTH_DB_TIMEOUT_MS);
    expect(resolveAuthDbTimeoutMs('0')).toBe(DEFAULT_AUTH_DB_TIMEOUT_MS);
    expect(resolveAuthDbTimeoutMs('-5')).toBe(DEFAULT_AUTH_DB_TIMEOUT_MS);
    expect(resolveAuthDbTimeoutMs('abc')).toBe(DEFAULT_AUTH_DB_TIMEOUT_MS);
  });
  test('honors a valid override', () => {
    expect(resolveAuthDbTimeoutMs('1500')).toBe(1500);
  });
});
