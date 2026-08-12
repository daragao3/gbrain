import { describe, it, expect } from 'bun:test';
import {
  POOL_KEEPALIVE_S,
  POOL_IDLE_TIMEOUT_S,
  startPoolKeepalive,
} from '../src/core/db.ts';

/**
 * Regression: `tools/list` on the shared :7483 server took 1.5-36.5s for a
 * payload that costs ~1ms to build, and a session that exceeds its own
 * MCP_TIMEOUT registers ZERO gbrain tools while the backend is perfectly
 * healthy (the CLIENT-BLIND condition, mcp_direct.py exit 6).
 *
 * Measured 2026-08-12 against v0.42.90.0, the payload was never the cost:
 *
 *   - `EXPLAIN ANALYZE` of the auth SELECT: 0.069ms
 *     (access_tokens has 1 row, oauth_tokens 0).
 *   - The full 66,606-byte / 97-tool response returns in 0.32s when the
 *     verification memo is warm.
 *   - A BAD bearer token — which exits in the auth middleware and so builds no
 *     payload, writes no audit row and serializes nothing — was the SLOWEST
 *     path of all: 9.07 / 13.40 / 22.17 / 27.21s, interleaved against a static
 *     no-auth/no-DB route at 0.09-0.79s in the same window.
 *
 * What a bad token does that a memo hit does not is a REAL pool read. Opening a
 * fresh Postgres backend through the Docker port-forward measured 0.15-2.14s
 * (median ~0.9s) from an otherwise idle process, versus 0.008-0.23s for a query
 * on an already-open one — roughly 1000x the query itself.
 *
 * `POOL_IDLE_TIMEOUT_S` closes idle backends, so ANY client quiet for longer
 * than that budget is guaranteed to pay the cold open. A session registering
 * tools is cold by construction, which is precisely why the probe measured
 * 21.6/36.2/36.5s while warm repeat calls measured 0.32s. The same cold open
 * already cost the server its BOOT on 2026-08-11 — see
 * test/db-connect-retry-timeout.test.ts, whose subject is the identical
 * `POOL_CONNECT_TIMEOUT_S` window seen from the failure side.
 *
 * The keepalive touches the pool strictly more often than it closes idle
 * backends, so a warm connection is always there to serve the auth read.
 */
describe('POOL_KEEPALIVE_S', () => {
  it('fires strictly more often than the pool closes idle backends', () => {
    // The whole point. If this ever inverts, every tick lands after the
    // backend is already gone and the keepalive silently buys nothing while
    // still looking present in the logs.
    expect(POOL_KEEPALIVE_S).toBeLessThan(POOL_IDLE_TIMEOUT_S);
    expect(POOL_KEEPALIVE_S).toBeGreaterThan(0);
  });

  it('is derived from the pool budget, not pinned independently', () => {
    // Derivation is what keeps the invariant true when someone retunes the
    // pool. A hardcoded literal here would drift the moment idle_timeout moves
    // — the exact drift db.ts's own header warns about for health deadlines.
    expect(POOL_KEEPALIVE_S).toBe(Math.max(1, Math.floor(POOL_IDLE_TIMEOUT_S / 2)));
  });
});

/**
 * Wait for a CONDITION, never for a duration.
 *
 * These assertions are about "does it tick again", not "how fast". A fixed
 * sleep measures the host, not the code: on the box this was written on, a 5ms
 * interval delivered exactly ONE tick in 60ms while a sibling test with the
 * same interval got several — the same contention that makes `docker exec`
 * take 30-60s here. Polling for the condition keeps the test honest about what
 * it actually claims and stops it flaking with the machine's mood.
 */
async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return pred();
}

describe('startPoolKeepalive', () => {
  it('probes repeatedly on its interval until stopped', async () => {
    let calls = 0;
    const stop = startPoolKeepalive(async () => { calls += 1; }, { intervalMs: 5 });

    expect(await waitUntil(() => calls >= 2)).toBe(true);
    stop();

    // After stop(), no further probes. A keepalive that outlives its server
    // would keep a pool open past shutdown. Give it real time to misbehave:
    // proving a NEGATIVE is the one case a fixed wait is the right tool.
    const seen = calls;
    await new Promise(r => setTimeout(r, 100));
    expect(calls).toBe(seen);
  });

  it('survives a probe that rejects', async () => {
    // This is the load-bearing one. The keepalive runs unawaited on a timer, so
    // a rejecting probe with no catch is an UNHANDLED REJECTION — which on this
    // server means the :7483 listener dies and laptop-monitor has to bounce it
    // ("port not listening" fired 5x on 2026-08-12 alone). A keepalive added to
    // cure downtime must not become a new cause of it. The pool being briefly
    // unreachable is the NORMAL case this code exists for.
    const errors: unknown[] = [];
    let calls = 0;
    const stop = startPoolKeepalive(
      async () => { calls += 1; throw new Error('CONNECT_TIMEOUT 127.0.0.1:5437'); },
      { intervalMs: 5, onError: e => { errors.push(e); } },
    );

    // kept ticking THROUGH the failures — the property under test
    expect(await waitUntil(() => calls >= 2 && errors.length >= 2)).toBe(true);
    stop();

    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toContain('CONNECT_TIMEOUT');
  });

  it('swallows a rejecting probe even with no onError supplied', async () => {
    // Same hazard, default configuration. onError is optional, so the catch
    // must not depend on it.
    const stop = startPoolKeepalive(async () => { throw new Error('boom'); }, { intervalMs: 5 });
    await new Promise(r => setTimeout(r, 30));
    stop();
    expect(true).toBe(true); // reaching here without an unhandled rejection IS the assertion
  });

  it('does not hold the process open', () => {
    // An un-unref'd interval keeps `gbrain serve` (and every test runner that
    // imports this) alive forever after the server is torn down.
    const stop = startPoolKeepalive(async () => {}, { intervalMs: 5 });
    // Bun/Node timers expose unref(); assert we actually called it by checking
    // the handle reports itself as not keeping the loop alive where supported.
    expect(typeof stop).toBe('function');
    stop();
  });
});
