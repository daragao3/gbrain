/**
 * Regression test: process-tree teardown for scripts/run-serial-tests.sh.
 *
 * OBSERVED 2026-07-28: after stopping two `bun run test` runs, nine
 * `run-serial-tests.sh` processes were still alive, every one with a dead
 * parent PID, each still spawning fresh `bun test` children hours later.
 * They accumulate across sessions and are a material contributor to the
 * "30 live bun processes at 100% CPU" state that makes every test-timing
 * measurement worthless.
 *
 * Three failure modes are pinned here, from the inside out:
 *
 *   (1) ORPHAN WATCHDOG — run-serial-tests.sh's parent dies without
 *       signalling it (the orphan case: nothing ever delivers a signal, so
 *       a trap alone cannot save us). The script must notice its watched
 *       parent is gone and tear itself down.
 *
 *   (2) SIGNAL TRAP — run-serial-tests.sh receives SIGTERM directly. Bash
 *       runs a foreground child in the *same* process group, so a plain
 *       `kill <script-pid>` reaps the script and leaves `bun test` running.
 *       The trap must take the child down too.
 *
 *   (3) FULL CHAIN — `bun run test` (i.e. run-unit-parallel.sh) is killed
 *       while the serial pass is in flight. run-unit-parallel.sh is then an
 *       orphan but still ALIVE, so run-serial-tests.sh's own watchdog would
 *       never fire on its own. The wrapper has to notice and take the whole
 *       tree with it. This is the exact shape of the reported repro.
 *
 * Assertion strategy is PID-free and therefore portable: the serial fixture
 * files drop marker files on a timeline. `a-slow` writes `a-started`
 * immediately, sleeps, then writes `a-done`; `b-second` writes `b-started`.
 * A torn-down tree produces `a-started` and nothing else. Critically,
 * `a-done` is written by the *grandchild* `bun` process, so its absence is
 * what proves the whole tree died rather than just the shell.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const PARALLEL_SH_SRC = resolve(REPO_ROOT, 'scripts/run-unit-parallel.sh');
const SHARD_SH_SRC = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');
const SERIAL_SH_SRC = resolve(REPO_ROOT, 'scripts/run-serial-tests.sh');
const PROC_TREE_SH_SRC = resolve(REPO_ROOT, 'scripts/lib/proc-tree.sh');

let TMPROOT: string;
let MARKERS: string;

/** Every process this file spawned, so afterEach can guarantee no leaks of its own. */
const spawned: ChildProcess[] = [];

function sh(...parts: string[]): string {
  return join(TMPROOT, ...parts);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Spawn `bash -c "<body>"`. The trailing `:` command is load-bearing: bash
 * exec-optimizes `bash -c '<single command>'` into the command itself, which
 * would make the returned pid the script's own pid instead of a real
 * intermediate parent. A second command defeats that optimization so we get
 * a genuine parent we can kill to orphan the script.
 */
function spawnIntermediate(body: string): ChildProcess {
  const child = spawn('bash', ['-c', `${body}; :`], {
    cwd: TMPROOT,
    env: { ...process.env, GBRAIN_TEARDOWN_MARKERS: MARKERS },
    stdio: 'ignore',
  });
  spawned.push(child);
  return child;
}

beforeAll(() => {
  TMPROOT = mkdtempSync(join(tmpdir(), 'gbrain-serial-teardown-'));
  MARKERS = join(TMPROOT, 'markers');
  mkdirSync(join(TMPROOT, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(TMPROOT, 'test'), { recursive: true });
  mkdirSync(MARKERS, { recursive: true });

  for (const [src, dest] of [
    [PARALLEL_SH_SRC, sh('scripts', 'run-unit-parallel.sh')],
    [SHARD_SH_SRC, sh('scripts', 'run-unit-shard.sh')],
    [SERIAL_SH_SRC, sh('scripts', 'run-serial-tests.sh')],
    [PROC_TREE_SH_SRC, sh('scripts', 'lib', 'proc-tree.sh')],
  ] as const) {
    // Tolerant copy: the shared helper is optional so this file fails on its
    // behavioural assertions rather than erroring out during setup.
    if (!existsSync(src)) continue;
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
  }

  // Serial fixtures. `find | sort` puts a-slow before b-second, so b-second
  // only ever runs if the runner survived a-slow.
  const slow = `import { describe, it } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
const M = process.env.GBRAIN_TEARDOWN_MARKERS!;
const SLEEP_MS = Number(process.env.GBRAIN_TEARDOWN_SLEEP_MS || '10000');
describe('a-slow', () => {
  it('marks start, sleeps, marks done', async () => {
    writeFileSync(join(M, 'a-started'), 'x');
    await Bun.sleep(SLEEP_MS);
    writeFileSync(join(M, 'a-done'), 'x');
  }, SLEEP_MS + 30000);
});`;

  const second = `import { describe, it } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
const M = process.env.GBRAIN_TEARDOWN_MARKERS!;
describe('b-second', () => {
  it('marks that the runner advanced to the next serial file', () => {
    writeFileSync(join(M, 'b-started'), 'x');
  });
});`;

  writeFileSync(sh('test', 'a-slow.serial.test.ts'), slow);
  writeFileSync(sh('test', 'b-second.serial.test.ts'), second);

  // One trivial non-serial file so run-unit-parallel.sh's parallel pass has
  // something to do and completes fast, reaching the serial pass in ~seconds.
  writeFileSync(
    sh('test', 'trivial.test.ts'),
    `import { it, expect } from 'bun:test';\nit('ok', () => { expect(1).toBe(1); });`,
  );
});

afterEach(async () => {
  // Reset markers between cases.
  rmSync(MARKERS, { recursive: true, force: true });
  mkdirSync(MARKERS, { recursive: true });
  // Belt-and-suspenders: only ever touches PIDs this file created.
  for (const c of spawned.splice(0)) {
    try {
      if (c.pid && c.exitCode === null) process.kill(c.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

afterAll(async () => {
  if (!TMPROOT) return;
  // Windows refuses to remove a directory that is any live process's cwd, and
  // the KILL sweeps this suite triggers can still be unwinding when we get
  // here. Retry briefly, then leave the tempdir to the OS reaper — failing the
  // suite over cleanup would turn a passing regression test into a red one.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(TMPROOT, { recursive: true, force: true });
      return;
    } catch {
      await sleep(1000);
    }
  }
});

describe('run-serial-tests.sh process-tree teardown', () => {
  it('tears itself down when its parent dies without signalling it (orphan watchdog)', async () => {
    const parent = spawnIntermediate(`bash "${sh('scripts', 'run-serial-tests.sh')}" > serial.log 2>&1`);

    expect(await waitForFile(join(MARKERS, 'a-started'), 40000)).toBe(true);

    // SIGKILL the intermediate: no cleanup runs, run-serial-tests.sh is
    // orphaned exactly as observed in the wild.
    process.kill(parent.pid!, 'SIGKILL');

    await sleep(13000);

    expect(existsSync(join(MARKERS, 'a-done'))).toBe(false);
    expect(existsSync(join(MARKERS, 'b-started'))).toBe(false);
  }, 70000);

  it('kills the in-flight bun child when it receives SIGTERM (signal trap)', async () => {
    // `exec` keeps the pid, so the value written to serial-shell.pid IS the
    // pid of run-serial-tests.sh, expressed in the shell's own pid namespace.
    // That indirection is required on Windows: Node's process.kill() maps to
    // TerminateProcess, which destroys the shell WITHOUT delivering a
    // trappable signal, so it can never exercise a trap. Only a signal sent
    // from inside the same (Cygwin) pid namespace is a real SIGTERM.
    const script = spawnIntermediate(
      `echo $$ > serial-shell.pid; exec bash "${sh('scripts', 'run-serial-tests.sh')}" > serial-term.log 2>&1`,
    );

    expect(await waitForFile(join(MARKERS, 'a-started'), 60000)).toBe(true);

    const shellPid = readFileSync(join(TMPROOT, 'serial-shell.pid'), 'utf-8').trim();
    expect(shellPid).toMatch(/^\d+$/);

    // Signals the script's pid ONLY. Bash runs its foreground child in the
    // same process group, so without a trap the `bun test` outlives this.
    const killed = spawnSync('bash', ['-c', `kill -TERM ${shellPid}`], { encoding: 'utf-8' });
    expect(killed.status).toBe(0);

    await sleep(13000);

    expect(existsSync(join(MARKERS, 'a-done'))).toBe(false);
    expect(existsSync(join(MARKERS, 'b-started'))).toBe(false);
    expect(script.pid).toBeDefined();
  }, 100000);

  it('tears down the serial tree when run-unit-parallel.sh is orphaned mid-serial-pass', async () => {
    const parent = spawn(
      'bash',
      ['-c', `bash "${sh('scripts', 'run-unit-parallel.sh')}" --shards 1 > parallel.log 2>&1; :`],
      {
        cwd: TMPROOT,
        env: {
          ...process.env,
          GBRAIN_TEARDOWN_MARKERS: MARKERS,
          GBRAIN_TEARDOWN_SLEEP_MS: '25000',
        },
        stdio: 'ignore',
      },
    );
    spawned.push(parent);

    // The whole parallel pass must finish before the serial pass starts.
    // Measured at ~126s for this trivial fixture set on a loaded Windows box
    // (bun startup and Cygwin process spawn dominate), so the window is sized
    // well past that rather than to the ideal-machine number.
    expect(await waitForFile(join(MARKERS, 'a-started'), 240000)).toBe(true);

    process.kill(parent.pid!, 'SIGKILL');

    await sleep(18000);

    expect(existsSync(join(MARKERS, 'a-done'))).toBe(false);
    expect(existsSync(join(MARKERS, 'b-started'))).toBe(false);
  }, 330000);
});

/**
 * Characterization tests for the contract the teardown work put most at risk.
 *
 * Adding supervision meant moving each file's `bun test` from a foreground
 * call into a backgrounded child polled in a loop, which changes exactly how
 * the per-file exit status is obtained (`if ! bun test` became a `wait` on a
 * reaped pid). Getting that subtly wrong would make the serial pass swallow
 * failures — the same silent-green class the sibling wrapper test calls the
 * hardest contract to break in a fan-out runner. These fixtures are tiny and
 * sleep-free, so they cost seconds.
 */
describe('run-serial-tests.sh exit-code propagation', () => {
  let RCROOT: string;

  beforeAll(() => {
    RCROOT = mkdtempSync(join(tmpdir(), 'gbrain-serial-rc-'));
    mkdirSync(join(RCROOT, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(RCROOT, 'test'), { recursive: true });
    copyFileSync(SERIAL_SH_SRC, join(RCROOT, 'scripts', 'run-serial-tests.sh'));
    copyFileSync(PROC_TREE_SH_SRC, join(RCROOT, 'scripts', 'lib', 'proc-tree.sh'));

    const pass = `import { it, expect } from 'bun:test';\nit('passes', () => { expect(1).toBe(1); });`;
    writeFileSync(join(RCROOT, 'test', 'p1.serial.test.ts'), pass);
    writeFileSync(join(RCROOT, 'test', 'p2.serial.test.ts'), pass);
  });

  afterAll(() => {
    if (RCROOT) rmSync(RCROOT, { recursive: true, force: true });
  });

  function runSerial() {
    return spawnSync('bash', [join(RCROOT, 'scripts', 'run-serial-tests.sh')], {
      cwd: RCROOT,
      encoding: 'utf-8',
      env: { ...process.env },
    });
  }

  it('exits zero and reports the file count when every serial file passes', () => {
    const r = runSerial();
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('all 2 file(s) passed');
  });

  it('exits non-zero and names each failing file', () => {
    const failing = `import { it, expect } from 'bun:test';\nit('fails on purpose', () => { expect(1).toBe(2); });`;
    writeFileSync(join(RCROOT, 'test', 'f1.serial.test.ts'), failing);
    try {
      const r = runSerial();
      expect(r.status).not.toBe(0);
      const out = `${r.stdout}${r.stderr}`;
      expect(out).toContain('1 file(s) failed');
      expect(out).toContain('test/f1.serial.test.ts');
    } finally {
      rmSync(join(RCROOT, 'test', 'f1.serial.test.ts'), { force: true });
    }
  });
});
