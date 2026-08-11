/**
 * Tests for probeHealth(), probeLiveness(), and the /health deadline constants
 * in src/commands/serve-http.ts.
 *
 * v0.28.10 split: /health now calls probeLiveness (sql`SELECT 1`); the heavier
 * probeHealth (engine.getStats()) moved behind requireAdmin at
 * /admin/api/full-stats. Both share ProbeHealthResult so the route handlers
 * stay 2-line dispatches.
 *
 * 2026-08-11 false-negative fix: probeLiveness used to race `SELECT 1` against
 * a 3000ms deadline and return 503 "database pool may be saturated" on expiry.
 * That deadline was SHORTER than the pool's own `connect_timeout` (10s), so a
 * cold reconnect — mandatory after `idle_timeout` (20s) of quiet, and allowed
 * up to 10s — could never win the race. A healthy-but-idle brain reported 503
 * for a pool with nothing saturated, while POST /mcp tool calls (which carry no
 * such server-side deadline) succeeded on the very same pool.
 *
 * The three-state model that replaced it is what most of these tests pin:
 *   - fast probe                     -> 200 {status:'ok'}      (body shape frozen)
 *   - slow probe, no proven failure  -> 200 {status:'degraded'} (NOT a failure)
 *   - probe rejected / past ceiling  -> 503 {status:'unavailable'}
 *
 * Calls each probe directly with a mock — no Express test client, no module
 * mocking. Express-layer wiring (deadline actually propagates through the
 * route, body shape after JSON serialization) is covered by /health +
 * /admin/api/full-stats cases in test/e2e/serve-http-oauth.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import {
  HEALTH_TIMEOUT_MS,
  HEALTH_RESPONSE_TIMEOUT_MS,
  HEALTH_HARD_CEILING_MS,
  createLivenessProbeState,
  probeHealth,
  probeLiveness,
} from '../src/commands/serve-http.ts';
import { POOL_CONNECT_TIMEOUT_S, POOL_IDLE_TIMEOUT_S } from '../src/core/db.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SqlQuery } from '../src/core/oauth-provider.ts';

/**
 * Minimal mock engine: only `getStats()` is exercised by probeHealth.
 * Cast to BrainEngine is safe — probeHealth doesn't touch other methods.
 */
function makeMockEngine(getStats: () => Promise<unknown>): BrainEngine {
  return { getStats } as unknown as BrainEngine;
}

/**
 * Minimal mock sql tag: probeLiveness only awaits the result of `sql\`SELECT 1\``
 * — the tag function's return value is what's raced, success/throw is what
 * matters. We ignore the template strings and simulate a connection by calling
 * the supplied factory.
 */
function makeMockSql(fn: () => Promise<unknown>): SqlQuery {
  const tag: any = (_strings: TemplateStringsArray, ..._values: unknown[]) => fn();
  return tag as SqlQuery;
}

/** An sql tag whose `SELECT 1` resolves after `ms` — i.e. a cold/slow pool. */
function makeSlowSql(ms: number): SqlQuery {
  return makeMockSql(() => new Promise(resolve => setTimeout(() => resolve([{ '?column?': 1 }]), ms)));
}

describe('health deadline constants', () => {
  test('the response deadline stays 3000ms (2s of headroom under Fly.io\'s 5s default)', () => {
    expect(HEALTH_RESPONSE_TIMEOUT_MS).toBe(3000);
  });

  test('HEALTH_TIMEOUT_MS is retained as an alias of the response deadline', () => {
    expect(HEALTH_TIMEOUT_MS).toBe(HEALTH_RESPONSE_TIMEOUT_MS);
  });

  /**
   * THE INVARIANT. This is the regression test for the 2026-08-11 defect.
   *
   * A verdict deadline shorter than the pool's own connect budget is
   * unsatisfiable by construction: postgres.js is allowed `connect_timeout`
   * seconds to open a backend, and `idle_timeout` guarantees it will have to
   * open one after a quiet period. If this assertion ever fails, someone has
   * lowered the ceiling or raised the pool's connect budget, and /health has
   * gone back to reporting cold pools as dead backends.
   */
  test('INVARIANT: the failure ceiling exceeds the pool connect budget', () => {
    expect(HEALTH_HARD_CEILING_MS).toBeGreaterThan(POOL_CONNECT_TIMEOUT_S * 1000);
  });

  test('INVARIANT: a 9920ms cold reconnect (measured on this host 2026-07-13) is inside the ceiling', () => {
    // The exact observation that motivated the fix. It sits inside the pool's
    // 10s connect budget, so it must NOT be judged a failure.
    expect(9920).toBeLessThan(HEALTH_HARD_CEILING_MS);
  });

  test('the ceiling is derived from the pool config, not independently hardcoded', () => {
    // Derivation, not coincidence: changing POOL_CONNECT_TIMEOUT_S must move
    // the ceiling with it. Pinning the arithmetic is what makes the invariant
    // above impossible to satisfy by accident.
    expect(HEALTH_HARD_CEILING_MS).toBe(POOL_CONNECT_TIMEOUT_S * 1000 + 2000);
    expect(POOL_IDLE_TIMEOUT_S).toBeGreaterThan(0);
  });
});

describe('probeHealth', () => {
  test('happy path: returns 200 + status:ok + spread stats', async () => {
    const engine = makeMockEngine(async () => ({ pages: 42, links: 10 }));
    const result = await probeHealth(engine, 'pglite', '0.27.1', 100);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    if (result.ok) {
      expect(result.body.status).toBe('ok');
      expect(result.body.version).toBe('0.27.1');
      expect(result.body.engine).toBe('pglite');
      expect(result.body.pages).toBe(42);
      expect(result.body.links).toBe(10);
    }
  });

  test('timeout path: getStats() hangs forever → 503 that reports a timing observation, not a diagnosis', async () => {
    const engine = makeMockEngine(() => new Promise(() => { /* never resolves */ }));
    const start = Date.now();
    const result = await probeHealth(engine, 'pglite', '0.27.1', 100);
    const elapsed = Date.now() - start;
    // Loose bound on purpose. getStats() here never resolves, so the only
    // alternative to "the timeout fired" is "hangs forever" — a 5s ceiling
    // separates those two just as well as a tight one, without turning the
    // test into a load meter for the host. (Observed 1061ms for a 100ms timer
    // on this box under concurrent agent load.)
    expect(elapsed).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    if (!result.ok) {
      expect(result.body.error).toBe('service_unavailable');
      // Regression: the old text asserted "database pool may be saturated",
      // which was wrong in BOTH directions — it fired on a cold pool (nothing
      // saturated) and on 2026-07-17 when the database was entirely dead
      // (nothing saturated either). The replacement states the observation and
      // explicitly declines to name a cause.
      expect(result.body.error_description).not.toContain('saturated');
      expect(result.body.error_description).toContain('100ms');
      expect(result.body.error_description).toContain('cause not determined');
    }
  });

  test('db-error path: getStats() rejects → 503 carrying the underlying error', async () => {
    const engine = makeMockEngine(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await probeHealth(engine, 'postgres', '0.27.1', 100);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    if (!result.ok) {
      expect(result.body.error).toBe('service_unavailable');
      // The error text is the single most useful field in an outage. The old
      // implementation threw it away and printed a fixed string.
      expect(result.body.error_description).toContain('ECONNREFUSED');
    }
  });
});

describe('probeLiveness — fast path', () => {
  test('happy path: 200 + status:ok with NO engine-stats fields', async () => {
    const sql = makeMockSql(async () => [{ '?column?': 1 }]);
    const result = await probeLiveness(sql, 'postgres', '0.28.10', 100);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    if (result.ok) {
      expect(result.body.status).toBe('ok');
      expect(result.body.version).toBe('0.28.10');
      expect(result.body.engine).toBe('postgres');
      // Regression: the lightweight body must NOT spread getStats() fields,
      // and the fast-path shape is frozen at exactly three keys — the e2e
      // suite asserts the same triple over the wire.
      expect(Object.keys(result.body).sort()).toEqual(['engine', 'status', 'version']);
      expect((result.body as Record<string, unknown>).page_count).toBeUndefined();
      expect((result.body as Record<string, unknown>).chunk_count).toBeUndefined();
    }
  });

  test('db-error path: sql throws → 503 unavailable carrying the underlying error', async () => {
    const sql = makeMockSql(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await probeLiveness(sql, 'postgres', '0.28.10', 100);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    if (!result.ok) {
      expect(result.body.error).toBe('service_unavailable');
      expect(result.body.status).toBe('unavailable');
      expect(result.body.error_description).toContain('ECONNREFUSED');
      expect(result.body.error_description).not.toContain('saturated');
    }
  });

  test('timer-cleanup: 100 fast successful probes do not leak pending timers', async () => {
    const sql = makeMockSql(async () => [{ '?column?': 1 }]);
    // Snapshot active handles before; same after. If the finally-block
    // clearTimeout regressed, every probe would leak a pending timer.
    const beforeHandles = (process as any)._getActiveHandles?.()?.length ?? 0;
    await Promise.all(
      Array.from({ length: 100 }, () => probeLiveness(sql, 'postgres', '0.28.10', 100)),
    );
    await new Promise(r => setImmediate(r));
    const afterHandles = (process as any)._getActiveHandles?.()?.length ?? 0;
    expect(afterHandles - beforeHandles).toBeLessThan(20);
  });
});

describe('probeLiveness — a slow pool is DEGRADED, not UNAVAILABLE', () => {
  test('slow-but-successful probe answers 200 degraded within the response deadline', async () => {
    const state = createLivenessProbeState();
    const sql = makeSlowSql(3000); // inside the ceiling, far past the response deadline
    const start = Date.now();
    const result = await probeLiveness(sql, 'postgres', '0.28.10', {
      responseTimeoutMs: 100,
      hardCeilingMs: 10_000,
      state,
    });
    const elapsed = Date.now() - start;

    // Answers promptly — the endpoint never waits on the pool. The bound is
    // deliberately loose (100ms deadline vs a 3000ms query): this asserts that
    // /health returns without waiting for the database, not that the host's
    // timer scheduling is precise. Windows under agent load adds ~1s to a
    // sub-second timer, so anything tighter measures the box, not the code.
    expect(elapsed).toBeLessThan(2500);
    // And answers 200. This is the whole fix: a slow pool is not a dead one.
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    if (result.ok) {
      expect(result.body.status).toBe('degraded');
      expect(String(result.body.detail)).not.toContain('saturated');
      // The body has to teach the reader why slow != dead, or the next person
      // to see it will do what every reader did before: assume an outage.
      expect(String(result.body.detail)).toContain('connect_timeout');
    }
  });

  test('the in-flight probe completes in the background, so the NEXT call is a plain 200 ok', async () => {
    const state = createLivenessProbeState();
    const sql = makeSlowSql(120);

    const first = await probeLiveness(sql, 'postgres', '0.28.10', {
      responseTimeoutMs: 30, hardCeilingMs: 2000, state,
    });
    expect(first.ok && first.body.status).toBe('degraded');

    // Let the background probe land.
    await new Promise(r => setTimeout(r, 200));

    const second = await probeLiveness(sql, 'postgres', '0.28.10', {
      responseTimeoutMs: 30, hardCeilingMs: 2000, state,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.body.status).toBe('degraded'); // still slow, still alive
    // Crucially: never 503 for a pool that is answering.
    expect(second.status).toBe(200);
  });

  test('concurrent /health hits coalesce onto ONE probe (no pool checkout storm)', async () => {
    const state = createLivenessProbeState();
    let checkouts = 0;
    const sql = makeMockSql(() => {
      checkouts++;
      return new Promise(resolve => setTimeout(() => resolve([{ '?column?': 1 }]), 100));
    });

    await Promise.all(
      Array.from({ length: 10 }, () => probeLiveness(sql, 'postgres', '0.28.10', {
        responseTimeoutMs: 20, hardCeilingMs: 2000, state,
      })),
    );
    expect(checkouts).toBe(1);
  });

  test('a proven failure is remembered: once the probe rejects, later slow probes report 503', async () => {
    const state = createLivenessProbeState();
    const dead = makeMockSql(() => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:5437')));

    const first = await probeLiveness(dead, 'postgres', '0.28.10', {
      responseTimeoutMs: 30, hardCeilingMs: 2000, state,
    });
    expect(first.status).toBe(503);

    // Now the backend starts black-holing instead of refusing: the probe hangs.
    // Without the remembered failure this would read as "degraded" forever.
    const hanging = makeMockSql(() => new Promise(() => { /* never settles */ }));
    const second = await probeLiveness(hanging, 'postgres', '0.28.10', {
      responseTimeoutMs: 30, hardCeilingMs: 2000, state,
    });
    expect(second.ok).toBe(false);
    expect(second.status).toBe(503);
    if (!second.ok) {
      expect(second.body.status).toBe('unavailable');
      expect(second.body.error_description).toContain('ECONNREFUSED');
    }
  });

  test('past the hard ceiling the probe IS judged a failure (degraded does not last forever)', async () => {
    const state = createLivenessProbeState();
    const hanging = makeMockSql(() => new Promise(() => { /* never settles */ }));

    // First call: nothing proven yet → degraded.
    const first = await probeLiveness(hanging, 'postgres', '0.28.10', {
      responseTimeoutMs: 20, hardCeilingMs: 100, state,
    });
    expect(first.status).toBe(200);
    if (first.ok) expect(first.body.status).toBe('degraded');

    // Wait past the ceiling so the background probe gives its verdict.
    await new Promise(r => setTimeout(r, 200));

    const second = await probeLiveness(hanging, 'postgres', '0.28.10', {
      responseTimeoutMs: 20, hardCeilingMs: 100, state,
    });
    expect(second.ok).toBe(false);
    expect(second.status).toBe(503);
    if (!second.ok) {
      expect(second.body.status).toBe('unavailable');
      expect(second.body.error_description).not.toContain('saturated');
      expect(second.body.error_description).toContain('connect budget');
    }
  });
});

describe('probeLiveness — reproduction of the 2026-08-11 false negative at real scale', () => {
  /**
   * The reported bug, reproduced against the SHIPPING constants (no injected
   * deadlines): a `SELECT 1` that takes 3500ms — comfortably inside the pool's
   * own 10s connect budget — used to yield HTTP 503 "database pool may be
   * saturated". It must now yield HTTP 200.
   *
   * Runs at real scale deliberately (~3.6s): the whole defect was an
   * interaction between two real-world constants, and a scaled-down mock
   * cannot fail if someone re-lowers the shipping ones.
   */
  test('a 3500ms SELECT 1 no longer produces a 503', async () => {
    const state = createLivenessProbeState();
    const sql = makeSlowSql(3500);
    const start = Date.now();
    const result = await probeLiveness(sql, 'postgres', '0.28.10', { state });
    const elapsed = Date.now() - start;

    // Still answers inside Fly.io's 5s orchestrator budget.
    expect(elapsed).toBeGreaterThanOrEqual(HEALTH_RESPONSE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(5000);
    expect(result.status).toBe(200);
    if (result.ok) expect(result.body.status).toBe('degraded');

    // And the probe itself succeeds in the background — proving the pool was
    // never unhealthy, only cold.
    await new Promise(r => setTimeout(r, 400));
    const after = await probeLiveness(makeMockSql(async () => [{ '?column?': 1 }]), 'postgres', '0.28.10', { state });
    expect(after.status).toBe(200);
    if (after.ok) expect(after.body.status).toBe('ok');
  }, 15000);
});
