import { describe, it, expect } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeSupervisorAuditFilename } from '../src/core/minions/handlers/supervisor-audit.ts';
import { calculateBackoffMs, resolveHardStopMaxCrashes } from '../src/core/minions/supervisor.ts';
import { withEnv } from './helpers/with-env.ts';
import { terminateOwnedProcessTree } from '../src/core/minions/handlers/shell-platform.ts';

const INTEGRATION_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 45_000;
const EXIT_TIMEOUT_MS = 50_000;
const describeSigterm = process.platform === 'win32' ? describe.skip : describe;

type WorkerSpec =
  | { kind: 'exit' }
  | { kind: 'record-env'; varName: string }
  | { kind: 'record-argv' };

interface RenderedWorker {
  filename: 'worker.cmd' | 'worker.sh';
  contents: string;
}

function renderWorker(spec: WorkerSpec): RenderedWorker {
  if (process.platform === 'win32') {
    const commands = ['@echo off'];
    if (spec.kind === 'record-env') {
      commands.push(
        `set "RECORDED_VALUE=%${spec.varName}%"`,
        'if not defined RECORDED_VALUE set "RECORDED_VALUE=UNSET"',
        '> "%OUT_FILE%" echo %RECORDED_VALUE%',
      );
    } else if (spec.kind === 'record-argv') {
      commands.push('> "%OUT_FILE%" echo %*');
    }
    commands.push('exit /b 1');
    return { filename: 'worker.cmd', contents: `${commands.join('\r\n')}\r\n` };
  }

  const commands = ['#!/bin/sh'];
  if (spec.kind === 'record-env') {
    commands.push(`printf '%s\\n' "\${${spec.varName}-UNSET}" > "$OUT_FILE"`);
  } else if (spec.kind === 'record-argv') {
    commands.push(`printf '%s\\n' "$*" > "$OUT_FILE"`);
  }
  commands.push('exit 1');
  return { filename: 'worker.sh', contents: `${commands.join('\n')}\n` };
}

// ----- Integration test helpers -----

interface IntegrationHarness {
  root: string;
  pidFile: string;
  auditDir: string;
  workerScript: string;
  envOutFile: string;
  ownedChildren: Map<ReturnType<typeof spawn>, Promise<void>>;
  cleanup: () => Promise<void>;
}

type SupervisorHandle = ReturnType<typeof spawnSupervisor>;

/** Create per-test temp files and render one semantic worker fixture. */
function makeHarness(name: string, workerSpec: WorkerSpec): IntegrationHarness {
  const root = mkdtempSync(join(tmpdir(), `gbrain-sup-test-${name}-`));
  const pidFile = join(root, 'supervisor.pid');
  const auditDir = join(root, 'audit');
  const envOutFile = join(root, 'env-out.txt');
  const renderedWorker = renderWorker(workerSpec);
  const workerScript = join(root, renderedWorker.filename);

  writeFileSync(workerScript, renderedWorker.contents, 'utf8');
  if (process.platform !== 'win32') chmodSync(workerScript, 0o755);

  const ownedChildren = new Map<ReturnType<typeof spawn>, Promise<void>>();
  return {
    root,
    pidFile,
    auditDir,
    workerScript,
    envOutFile,
    ownedChildren,
    cleanup: async () => {
      const cleanupErrors: unknown[] = [];
      for (const [child, closed] of ownedChildren) {
        try {
          await terminateOwnedProcessTree(child);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await awaitCloseWithin(closed, 5_000, 'owned supervisor process');
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length === 0) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'supervisor test cleanup failed');
      }
    },
  };
}

/**
 * Spawn the supervisor runner as a subprocess. Returns a handle with the
 * child, a promise resolving to exit code + signal, and a kill helper.
 */
function spawnSupervisor(h: IntegrationHarness, overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SUP_PID_FILE: h.pidFile,
    SUP_CLI_PATH: h.workerScript,
    SUP_AUDIT_DIR: h.auditDir,
    SUP_BACKOFF_FLOOR_MS: '5',
    SUP_MAX_CRASHES: '3',
    SUP_HEALTH_INTERVAL_MS: '999999',   // effectively off
    ...overrides,
  };
  // issue #1994: the soft crash budget now DEGRADES (retry-with-backoff) rather
  // than permanently giving up; permanent give-up fires at a much-higher hard
  // ceiling (maxCrashes × 10). These integration tests assert the give-up
  // LIFECYCLE (audit events, exit code, pidfile cleanup), so pin the hard
  // ceiling to the soft budget by default — the degraded path is unit-tested in
  // child-worker-supervisor.test.ts. Tests that want true degraded behavior
  // pass GBRAIN_SUPERVISOR_HARD_STOP_CRASHES explicitly.
  if (env.GBRAIN_SUPERVISOR_HARD_STOP_CRASHES === undefined) {
    env.GBRAIN_SUPERVISOR_HARD_STOP_CRASHES = env.SUP_MAX_CRASHES;
  }

  const child = spawn(process.execPath, [join(import.meta.dir, 'fixtures/supervisor-runner.ts')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  h.ownedChildren.set(child, closed);

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => { stdout += d.toString(); });
  child.stderr?.on('data', (d) => { stderr += d.toString(); });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    closed,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function awaitCloseWithin(
  closed: Promise<void>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not close within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForSupervisorExit(
  sup: SupervisorHandle,
  timeoutMs = EXIT_TIMEOUT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const result = await sup.exited;
        await sup.closed;
        return result;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`supervisor did not exit and close within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await terminateOwnedProcessTree(sup.child);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await awaitCloseWithin(sup.closed, 5_000, 'owned supervisor process');
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'supervisor exit and termination cleanup failed',
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read the audit JSONL for the current week without mutating process.env. */
function readAudit(auditDir: string): Array<Record<string, unknown> & { event: string }> {
  const auditFile = join(auditDir, computeSupervisorAuditFilename());
  if (!existsSync(auditFile)) return [];
  return readFileSync(auditFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown> & { event: string }];
      } catch {
        return [];
      }
    });
}

/** Poll until predicate returns true or deadline elapses. */
async function waitFor(pred: () => boolean, timeoutMs: number, tickMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, tickMs));
  }
  return pred();
}

describe('MinionSupervisor', () => {
  describe('resolveHardStopMaxCrashes (issue #1994)', () => {
    const KEY = 'GBRAIN_SUPERVISOR_HARD_STOP_CRASHES';

    it('defaults to maxCrashes × 10 when no override', async () => {
      await withEnv({ [KEY]: undefined }, () => {
        expect(resolveHardStopMaxCrashes(10)).toBe(100);
        expect(resolveHardStopMaxCrashes(3)).toBe(30);
      });
    });

    it('honors a valid non-negative integer override', async () => {
      await withEnv({ [KEY]: '0' }, () => {
        expect(resolveHardStopMaxCrashes(10)).toBe(0);
      });
      await withEnv({ [KEY]: '5' }, () => {
        expect(resolveHardStopMaxCrashes(10)).toBe(5);
      });
    });

    it('ignores a negative or non-integer override (falls back to default)', async () => {
      await withEnv({ [KEY]: '-1' }, () => {
        expect(resolveHardStopMaxCrashes(10)).toBe(100);
      });
      await withEnv({ [KEY]: 'abc' }, () => {
        expect(resolveHardStopMaxCrashes(10)).toBe(100);
      });
    });
  });

  describe('calculateBackoffMs', () => {
    it('returns ~1s for first crash', () => {
      const backoff = calculateBackoffMs(0);
      expect(backoff).toBeGreaterThanOrEqual(1000);
      expect(backoff).toBeLessThan(1200); // 1000 + 10% jitter max
    });

    it('doubles with each crash', () => {
      const b0 = calculateBackoffMs(0);
      const b1 = calculateBackoffMs(1);
      const b2 = calculateBackoffMs(2);
      // Approximate: b1 should be ~2x b0, b2 ~2x b1 (within jitter)
      expect(b1).toBeGreaterThan(1800);
      expect(b2).toBeGreaterThan(3600);
    });

    it('caps at 60s', () => {
      const backoff = calculateBackoffMs(20); // 2^20 * 1000 would be huge
      expect(backoff).toBeLessThanOrEqual(66_000); // 60s + 10% jitter
    });

    it('includes jitter (not perfectly deterministic)', () => {
      const values = new Set<number>();
      for (let i = 0; i < 10; i++) {
        values.add(Math.round(calculateBackoffMs(3)));
      }
      // With 10% jitter, we should get some variation
      expect(values.size).toBeGreaterThan(1);
    });
  });

  describe('PID file management', () => {
    it('detects stale PID files', async () => {
      const h = makeHarness('stale-pid', { kind: 'exit' });
      try {
        // Write a PID file with a non-existent PID
        writeFileSync(h.pidFile, '999999999');
        expect(existsSync(h.pidFile)).toBe(true);

        // A real supervisor would detect this as stale and overwrite
        const existingPid = parseInt(readFileSync(h.pidFile, 'utf8').trim(), 10);
        let isAlive = false;
        try {
          process.kill(existingPid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
        expect(isAlive).toBe(false);
      } finally {
        await h.cleanup();
      }
    });

    it('detects live PID files (current process)', async () => {
      const h = makeHarness('live-pid', { kind: 'exit' });
      try {
        // Write our own PID
        writeFileSync(h.pidFile, String(process.pid));

        const existingPid = parseInt(readFileSync(h.pidFile, 'utf8').trim(), 10);
        let isAlive = false;
        try {
          process.kill(existingPid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
        expect(isAlive).toBe(true);
        expect(existingPid).toBe(process.pid);
      } finally {
        await h.cleanup();
      }
    });
  });

  describe('crash count tracking', () => {
    it('backoff escalates with crash count', () => {
      const backoffs = [];
      for (let i = 0; i < 7; i++) {
        backoffs.push(calculateBackoffMs(i));
      }
      // Each should be roughly 2x the previous (within jitter)
      for (let i = 1; i < 6; i++) {
        // The base doubles, so even with jitter the next should be > 1.5x previous
        expect(backoffs[i]).toBeGreaterThan(backoffs[i - 1] * 1.5);
      }
    });
  });

  // --------------------------------------------------------------
  // Integration tests: real spawn(), real signals, real audit file.
  // Each test uses a unique tmpdir harness so they can run in parallel
  // without colliding. `_backoffFloorMs: 5` (set via SUP_BACKOFF_FLOOR_MS)
  // keeps the whole suite under a few seconds.
  // --------------------------------------------------------------

  describe('integration: crash → restart → max-crashes lifecycle', () => {
    it('respawns the worker after a crash and eventually exits with max-crashes code=1', async () => {
      // Worker always exits with code 1; supervisor should respawn it 3 times,
      // hit max-crashes, then exit via shutdown() with code 1.
      const h = makeHarness('max-crashes', { kind: 'exit' });
      try {
        // hard ceiling defaults to SUP_MAX_CRASHES in the harness (see
        // spawnSupervisor) so this give-up lifecycle still fires at 3 (#1994).
        const sup = spawnSupervisor(h, { SUP_MAX_CRASHES: '3' });
        const { code } = await waitForSupervisorExit(sup);

        expect(code).toBe(1);

        // PID file cleaned up on exit (synchronous process.on('exit') handler).
        expect(existsSync(h.pidFile)).toBe(false);

        // Audit file should contain started + 3x worker_spawned/worker_exited +
        // max_crashes_exceeded + shutting_down + stopped.
        const events = readAudit(h.auditDir);
        const eventTypes = events.map(e => e.event);
        expect(eventTypes).toContain('started');
        expect(eventTypes.filter(t => t === 'worker_spawned').length).toBeGreaterThanOrEqual(3);
        expect(eventTypes.filter(t => t === 'worker_exited').length).toBeGreaterThanOrEqual(3);
        expect(eventTypes).toContain('max_crashes_exceeded');
        expect(eventTypes).toContain('shutting_down');
        expect(eventTypes).toContain('stopped');

        // The stopped event should carry exit_code=1 and reason=max_crashes.
        const stoppedEvt = events.filter(e => e.event === 'stopped').pop();
        expect((stoppedEvt as Record<string, unknown>).exit_code).toBe(1);
        expect((stoppedEvt as Record<string, unknown>).reason).toBe('max_crashes');
      } finally {
        await h.cleanup();
      }
    }, INTEGRATION_TIMEOUT_MS);
  });

  // Windows child.kill('SIGTERM') terminates the process and cannot prove the
  // catchable POSIX graceful-handler contract. Keep only this signal suite skipped.
  describeSigterm('integration: graceful POSIX SIGTERM handler during backoff', () => {
    it('receives SIGTERM while sleeping between crashes and exits 0 cleanly', async () => {
      // Worker always exits with code 1; supervisor has a high max-crashes
      // and a long-enough backoff floor that we can reliably catch it mid-sleep.
      const h = makeHarness('sigterm-backoff', { kind: 'exit' });
      try {
        const sup = spawnSupervisor(h, {
          SUP_MAX_CRASHES: '100',
          SUP_BACKOFF_FLOOR_MS: '800',  // 800ms between restarts — enough to catch
        });

        // Wait until the supervisor has written the PID file AND survived at
        // least one worker_exited (so it's definitely in the backoff sleep).
        const ready = await waitFor(() => {
          if (!existsSync(h.pidFile)) return false;
          const events = readAudit(h.auditDir);
          return events.some(e => e.event === 'worker_exited');
        }, READY_TIMEOUT_MS);
        expect(ready).toBe(true);

        // Now SIGTERM the supervisor. It must exit cleanly within 200ms
        // (short-circuits the 800ms backoff sleep via the stopping flag).
        const sigSentAt = Date.now();
        sup.child.kill('SIGTERM');

        const { code, signal } = await waitForSupervisorExit(sup);
        const elapsed = Date.now() - sigSentAt;

        // Exit code 0 = clean; signal=null means we exited via process.exit, not got killed.
        expect(code).toBe(0);
        expect(signal).toBe(null);
        // Graceful, not hung: exit within 5s (process.exit() through shutdown()
        // should be near-instant; generous bound to tolerate CI slowness).
        expect(elapsed).toBeLessThan(5000);

        const events = readAudit(h.auditDir);
        const eventTypes = events.map(e => e.event);
        expect(eventTypes).toContain('shutting_down');
        expect(eventTypes).toContain('stopped');

        const shuttingEvt = events.filter(e => e.event === 'shutting_down').pop();
        expect((shuttingEvt as Record<string, unknown>).reason).toBe('SIGTERM');

        // PID file cleaned up.
        expect(existsSync(h.pidFile)).toBe(false);
      } finally {
        await h.cleanup();
      }
    }, INTEGRATION_TIMEOUT_MS);
  });

  describe('integration: env-var inheritance regression (codex #9 / eng #8)', () => {
    it('strips inherited GBRAIN_ALLOW_SHELL_JOBS when allowShellJobs=false, even if parent has it set', async () => {
      // Worker writes env to OUT_FILE then exits 1. exit=1 is required (not
      // exit=0) because post-D1/D2 (v0.33) clean exits don't count toward
      // crashCount — the supervisor would respawn forever. The test's
      // assertion is on the OUT_FILE contents (env plumbing), not the
      // exit code, so any non-zero code that trips SUP_MAX_CRASHES=1 works.
      const h = makeHarness('env-strip-outfile', { kind: 'record-env', varName: 'GBRAIN_ALLOW_SHELL_JOBS' });

      try {
        const sup = spawnSupervisor(h, {
          OUT_FILE: h.envOutFile,
          GBRAIN_ALLOW_SHELL_JOBS: '1',  // parent has it
          SUP_ALLOW_SHELL_JOBS: '0',     // supervisor says NO
          SUP_MAX_CRASHES: '1',
        });

        await waitForSupervisorExit(sup);

        // Worker should have written "UNSET" (parent env var stripped from child).
        expect(existsSync(h.envOutFile)).toBe(true);
        const childSawEnv = readFileSync(h.envOutFile, 'utf8').trim();
        expect(childSawEnv).toBe('UNSET');
      } finally {
        await h.cleanup();
      }
    }, INTEGRATION_TIMEOUT_MS);

    it('DOES pass GBRAIN_ALLOW_SHELL_JOBS to child when allowShellJobs is true', async () => {
      // Worker exits 1 (not 0) so SUP_MAX_CRASHES=1 actually trips. See
      // the comment on the env-strip test above for the v0.33 rationale.
      const h = makeHarness('env-pass-on-opt-in', { kind: 'record-env', varName: 'GBRAIN_ALLOW_SHELL_JOBS' });

      try {
        const sup = spawnSupervisor(h, {
          OUT_FILE: h.envOutFile,
          SUP_ALLOW_SHELL_JOBS: '1',
          SUP_MAX_CRASHES: '1',
        });

        await waitForSupervisorExit(sup);

        expect(existsSync(h.envOutFile)).toBe(true);
        expect(readFileSync(h.envOutFile, 'utf8').trim()).toBe('1');
      } finally {
        await h.cleanup();
      }
    }, INTEGRATION_TIMEOUT_MS);
  });

  describe('integration: GBRAIN_SUPERVISED env var (v0.22.14)', () => {
    it('sets GBRAIN_SUPERVISED=1 on spawned worker child', async () => {
      // exit 1 required post-D1/D2 to trip SUP_MAX_CRASHES=1; clean exits
      // no longer count toward the crash limit.
      const h = makeHarness('supervised-env', { kind: 'record-env', varName: 'GBRAIN_SUPERVISED' });

      try {
        const sup = spawnSupervisor(h, {
          OUT_FILE: h.envOutFile,
          SUP_MAX_CRASHES: '1',
        });

        await waitForSupervisorExit(sup);

        expect(existsSync(h.envOutFile)).toBe(true);
        const childSawEnv = readFileSync(h.envOutFile, 'utf8').trim();
        expect(childSawEnv).toBe('1');
      } finally {
        await h.cleanup();
      }
    }, INTEGRATION_TIMEOUT_MS);
  });

  describe('regression (R3): healthInterval=0 disables timer (v0.22.14)', () => {
    // Pre-fix: supervisor unconditionally called setInterval(callback, 0),
    // which schedules a tight loop on the next event-loop tick. The
    // operator-facing CLI claim "Use 0 to disable" was a lie — passing 0
    // produced a DB-probe loop that hammered Postgres.
    //
    // Post-fix: setInterval is gated on healthInterval > 0. With 0, the
    // supervisor runs its supervise loop normally with the health timer
    // entirely absent.
    //
    // Assertion strategy: spawn the supervisor with SUP_HEALTH_INTERVAL_MS=0,
    // a fast worker that exits cleanly, and SUP_MAX_CRASHES=1. A working fix
    // should produce a single worker spawn → exit → supervisor shutdown
    // sequence. If the tight-loop bug returned, the supervisor would still
    // exit (max-crashes path) but the audit trail would show the tell-tale
    // signature of an extremely high health-check call rate during the brief
    // window before max-crashes fires. We assert the basic completion path
    // and let CI's wall-clock detect any pathological CPU spike.
    it('completes a normal supervise lifecycle with healthInterval=0', async () => {
      // exit 1 (not exit 0) because post-D1/D2 (v0.33) clean exits don't
      // count toward max_crashes — a code=0 worker would respawn forever.
      // The test's purpose is regression coverage that healthInterval=0
      // disables the timer; the exit code doesn't matter to that assertion.
      const h = makeHarness('health-interval-zero', { kind: 'exit' });

      try {
        const sup = spawnSupervisor(h, {
          SUP_HEALTH_INTERVAL_MS: '0',
          SUP_MAX_CRASHES: '1',
        });

        const { code } = await waitForSupervisorExit(sup);

        // Clean exit (max-crashes path returns 1; this is fine — we just
        // want to confirm the supervisor reached its terminal state without
        // hanging or runaway looping).
        expect(code).toBe(1);

        // The enclosing timeout is the hang net. Startup latency is not the
        // product contract, especially on Windows where process launch is slow.
      } finally {
        await h.cleanup();
      }
    }, INTEGRATION_TIMEOUT_MS);
  });

  describe('integration: --max-rss spawn args (v0.21, auto-sized v0.41.39.0)', () => {
    it('passes an explicit --max-rss through to the spawned worker', async () => {
      // SUP_MAX_RSS pins an explicit cap; the supervisor must pass it through
      // verbatim. exit 1 required post-D1/D2: code=0 workers respawn forever.
      const h = makeHarness('maxrss-explicit', { kind: 'record-argv' });

      try {
        const sup = spawnSupervisor(h, {
          OUT_FILE: h.envOutFile,
          SUP_MAX_CRASHES: '1',
          SUP_MAX_RSS: '2048',
        });

        await waitForSupervisorExit(sup);

        expect(existsSync(h.envOutFile)).toBe(true);
        const argv = readFileSync(h.envOutFile, 'utf8').trim();
        expect(argv).toContain('--max-rss 2048');
      } finally {
        await h.cleanup();
      }
    }, INTEGRATION_TIMEOUT_MS);

    // issue #1678: with no explicit cap the supervisor auto-sizes cgroup-aware
    // instead of the old flat 2048 footgun. Same machine → the in-test
    // resolveDefaultMaxRssMb() equals what the spawned supervisor computes.
    it('auto-sizes --max-rss when no explicit cap is given', async () => {
      const { resolveDefaultMaxRssMb } = await import('../src/core/minions/rss-default.ts');
      const expected = resolveDefaultMaxRssMb();

      const h = makeHarness('maxrss-auto', { kind: 'record-argv' });
      try {
        const sup = spawnSupervisor(h, {
          OUT_FILE: h.envOutFile,
          SUP_MAX_CRASHES: '1',
        });
        await waitForSupervisorExit(sup);

        expect(existsSync(h.envOutFile)).toBe(true);
        const argv = readFileSync(h.envOutFile, 'utf8').trim();
        expect(argv).toContain(`--max-rss ${expected}`);
        // Auto-sized value is clamped into the sane range, never the old 2048
        // unless the box genuinely resolves there.
        expect(expected).toBeGreaterThanOrEqual(4096);
        expect(expected).toBeLessThanOrEqual(16384);
      } finally {
        await h.cleanup();
      }
    }, INTEGRATION_TIMEOUT_MS);
  });

  describe('integration: audit file rotation + helper', () => {
    it('computeSupervisorAuditFilename returns supervisor-YYYY-Www.jsonl format', () => {
      const jan15_2026 = new Date(Date.UTC(2026, 0, 15));  // Thu
      expect(computeSupervisorAuditFilename(jan15_2026)).toMatch(/^supervisor-2026-W\d\d\.jsonl$/);
    });

    it('year-boundary ISO week: 2027-01-01 reports as 2026-W53', () => {
      const jan1_2027 = new Date(Date.UTC(2027, 0, 1));
      // ISO week: 2027-01-01 is Friday of W53 of 2026
      expect(computeSupervisorAuditFilename(jan1_2027)).toBe('supervisor-2026-W53.jsonl');
    });
  });
});
