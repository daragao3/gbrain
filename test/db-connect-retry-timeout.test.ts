import { describe, it, expect } from 'bun:test';
import {
  isRetryableDbConnectError,
  connectWithRetry,
  POOL_CONNECT_TIMEOUT_S,
} from '../src/core/db.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * Regression: `gbrain serve --http` died at boot on a TRANSIENT Postgres
 * connect timeout, so laptop-monitor's Restart-GbrainHttp spawns did not stick.
 *
 * Observed 2026-08-11 on the :7483 server (~/.claude/logs/gbrain-http.err.log):
 *
 *   ==== 2026-08-11T15:11:08Z gbrain-http spawn [laptop-monitor Restart-GbrainHttp]
 *        reason="port not listening" ====
 *   Cannot connect to database: write CONNECT_TIMEOUT 127.0.0.1:5437
 *
 * The host sat at 88-99% commit for ~45 minutes, so opening a fresh Postgres
 * backend intermittently exceeded POOL_CONNECT_TIMEOUT_S. postgres.js reports
 * that as `write CONNECT_TIMEOUT <host>:<port>` — a message NO pattern in
 * RETRYABLE_DB_CONNECT_PATTERNS matched. connectWithRetry therefore threw on
 * attempt 1 of 3 and the process exited, even though the retry machinery was
 * right there and the condition cleared within minutes. The proof it never
 * retried: the err log carries no `[connect] attempt N failed ... retrying`
 * line, and the monitor's own Postgres gate got an answer on ATTEMPT 2 at
 * 15:18:43Z. The monitor then had to re-fire for the identical reason.
 *
 * These tests import the REAL classifier from src/core/db.ts. An earlier
 * sibling test (test/connection-resilience.test.ts) keeps a LOCAL COPY of a
 * pattern list, so it cannot catch drift in the shipped one.
 */
describe('isRetryableDbConnectError — postgres.js connect timeout', () => {
  it('treats the exact 2026-08-11 boot-death message as retryable', () => {
    expect(isRetryableDbConnectError(new Error('write CONNECT_TIMEOUT 127.0.0.1:5437'))).toBe(true);
  });

  it('matches it when wrapped in the GBrainError summary the operator sees', () => {
    expect(
      isRetryableDbConnectError(
        new Error('Cannot connect to database: write CONNECT_TIMEOUT 127.0.0.1:5437'),
      ),
    ).toBe(true);
  });

  it('treats an OS-level socket timeout as retryable', () => {
    expect(isRetryableDbConnectError(new Error('connect ETIMEDOUT 127.0.0.1:5437'))).toBe(true);
  });

  it('still fails fast on a genuinely non-retryable error (no over-widening)', () => {
    expect(isRetryableDbConnectError(new Error('database "gbrain_db" does not exist'))).toBe(false);
    expect(isRetryableDbConnectError(new Error('relation "pages" does not exist'))).toBe(false);
  });
});

function fakeEngine(connect: () => Promise<void>): BrainEngine {
  return { connect } as unknown as BrainEngine;
}

describe('connectWithRetry — transient connect timeout', () => {
  it('rides out a connect timeout that clears before the attempts are spent', async () => {
    let calls = 0;
    const engine = fakeEngine(async () => {
      calls++;
      if (calls < 3) throw new Error('write CONNECT_TIMEOUT 127.0.0.1:5437');
    });

    await connectWithRetry(engine, {} as never, { baseDelayMs: 1 });

    expect(calls).toBe(3);
  });

  it('does not retry when the caller opts out (--no-retry-connect)', async () => {
    let calls = 0;
    const engine = fakeEngine(async () => {
      calls++;
      throw new Error('write CONNECT_TIMEOUT 127.0.0.1:5437');
    });

    await expect(
      connectWithRetry(engine, {} as never, { baseDelayMs: 1, noRetry: true }),
    ).rejects.toThrow(/CONNECT_TIMEOUT/);
    expect(calls).toBe(1);
  });

  /**
   * Budget invariant. laptop-monitor's Restart-GbrainHttp polls for the :7483
   * listener for 60s (Get-GbrainHttpBindPollBudget) and counts a hard failure
   * — feeding the 3-failures-in-30min breaker that logs "manual intervention
   * needed" — if nothing ever binds. The default retry budget must therefore
   * stay comfortably INSIDE that window, or a child still retrying at 60s
   * would trip the breaker while recovering. 3 attempts x 10s connect + 1s+2s
   * backoff ~= 33s < 60s. Raising attempts/baseDelayMs here without widening
   * the monitor's bind poll would make recovery worse, not better.
   */
  it('keeps the default budget inside the monitor 60s bind-poll window', async () => {
    let calls = 0;
    const engine = fakeEngine(async () => {
      calls++;
      throw new Error('write CONNECT_TIMEOUT 127.0.0.1:5437');
    });

    await expect(connectWithRetry(engine, {} as never, { baseDelayMs: 1 })).rejects.toThrow();

    const attempts = calls;
    const backoffMs = Array.from({ length: attempts - 1 }, (_, i) => 1000 * 2 ** i).reduce(
      (a, b) => a + b,
      0,
    );
    const worstCaseMs = attempts * POOL_CONNECT_TIMEOUT_S * 1000 + backoffMs;

    expect(attempts).toBe(3);
    expect(worstCaseMs).toBeLessThan(60_000);
  });
});
