/**
 * Regression tests (a) + (d) for scripts/run-unit-parallel.sh:
 *   (a) Exit-code propagation: a failing test in any shard MUST cause the
 *       wrapper to exit non-zero. The hardest contract to silently break
 *       in a fan-out wrapper (`for ... &; wait` returns the LAST child's
 *       status, not any failure's).
 *   (d) Failure-log contract: when any test fails, the wrapper writes
 *       extracted failure block(s) to .context/test-failures.log with
 *       `--- shard $i:` prefixes, and prints a loud stderr banner with
 *       the absolute path. Empty log ⇔ exit 0.
 *
 * The wrapper takes ~1.5 minutes against the real test suite. To keep
 * this regression test fast and hermetic, we point it at a tiny tempdir
 * containing one passing and one failing test, override the discovery
 * roots via env-vars, and run with --shards=2.
 *
 * NOT covered here: the heartbeat (timing-sensitive, not load-bearing
 * for correctness) and timeout / WEDGED markers (require synthesizing a
 * hung test which is fragile across machines). Those rely on the live
 * smoke tests captured in CHANGELOG measurements.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const PARALLEL_SH_SRC = resolve(REPO_ROOT, 'scripts/run-unit-parallel.sh');
const SHARD_SH_SRC = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');
const SERIAL_SH_SRC = resolve(REPO_ROOT, 'scripts/run-serial-tests.sh');

let TMPROOT: string;

function createFixtureRoot(): string {
  // Give every test its own repo-shaped tempdir. A test timeout stops Bun from
  // awaiting the test body; it does not guarantee spawned descendants exited,
  // so sharing this tree lets one timed-out case mutate the next case's files.
  const root = mkdtempSync(join(tmpdir(), 'gbrain-parallel-test-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });

  copyFileSync(PARALLEL_SH_SRC, join(root, 'scripts', 'run-unit-parallel.sh'));
  copyFileSync(SHARD_SH_SRC, join(root, 'scripts', 'run-unit-shard.sh'));
  copyFileSync(SERIAL_SH_SRC, join(root, 'scripts', 'run-serial-tests.sh'));
  chmodSync(join(root, 'scripts', 'run-unit-parallel.sh'), 0o755);
  chmodSync(join(root, 'scripts', 'run-unit-shard.sh'), 0o755);
  chmodSync(join(root, 'scripts', 'run-serial-tests.sh'), 0o755);

  return root;
}

beforeEach(() => {
  // Build a tiny repo-shaped tempdir with the wrapper scripts copied in
  // and 4 fixture test files (3 pass, 1 fail). The wrapper's `find test`
  // expression will pick them up via cwd.
  TMPROOT = createFixtureRoot();

  // 3 passing + 1 failing test file. Round-robin sharding will land
  // them across 2 shards so we exercise the multi-shard merge path.
  const passing = `import { describe, it, expect } from 'bun:test';
describe('passing', () => {
  it('arithmetic works', () => { expect(1 + 1).toBe(2); });
});`;
  const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2 (this should fail)', () => { expect(1).toBe(2); });
});`;

  writeFileSync(join(TMPROOT, 'test', 'a-pass.test.ts'), passing);
  writeFileSync(join(TMPROOT, 'test', 'b-pass.test.ts'), passing);
  writeFileSync(join(TMPROOT, 'test', 'c-pass.test.ts'), passing);
  writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
});

afterEach(() => {
  if (TMPROOT) rmSync(TMPROOT, { recursive: true, force: true });
});

function isRunningNonZombie(pid: string | number): boolean {
  if (process.platform === 'win32') {
    const probe = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
    ]);
    return probe.status === 0;
  }

  // `kill -0` reports zombies as live. Docker test containers have no init to
  // reap orphaned descendants, so assert that owned PIDs are absent OR zombies.
  const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' });
  return probe.status === 0 && !probe.stdout.trim().startsWith('Z');
}

function runWrapper(
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
  nativeTimeout = 120_000,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    'bash',
    [join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '2', ...extraArgs],
    {
      cwd: TMPROOT,
      encoding: 'utf-8',
      timeout: nativeTimeout,
      env: { ...process.env, ...extraEnv },
    },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('run-unit-parallel.sh numeric bounds', () => {
  const oversized = '999999999999999999999999';

  it('rejects a shard timeout beyond Bash integer range', () => {
    const result = runWrapper(['--dry-run'], {
      GBRAIN_TEST_SHARD_TIMEOUT: oversized,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('invalid GBRAIN_TEST_SHARD_TIMEOUT');
  });

  it('rejects a stall timeout beyond Bash integer range', () => {
    const result = runWrapper(['--dry-run'], {
      GBRAIN_TEST_SHARD_STALL_SECONDS: oversized,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('invalid GBRAIN_TEST_SHARD_STALL_SECONDS');
  });

  it('rejects a stall poll interval beyond Bash integer range', () => {
    const result = runWrapper(['--dry-run'], {
      GBRAIN_TEST_SHARD_STALL_POLL_SECONDS: oversized,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('invalid GBRAIN_TEST_SHARD_STALL_POLL_SECONDS');
  });
});

describe('run-unit-parallel.sh Windows memory bound', () => {
  it('defaults Windows Bun to one shard and derives enough wallclock for it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unit-parallel-'));
    const uname = join(dir, 'uname');
    const bun = join(dir, 'bun');
    const nproc = join(dir, 'nproc');
    const extraFiles: string[] = [];

    try {
      writeFileSync(uname, '#!/usr/bin/env bash\necho Linux\n');
      writeFileSync(bun, '#!/usr/bin/env bash\necho win32\n');
      writeFileSync(nproc, '#!/usr/bin/env bash\necho 16\n');
      chmodSync(uname, 0o755);
      chmodSync(bun, 0o755);
      chmodSync(nproc, 0o755);

      // 55 files total × the Windows 30s/file budget = 1650s. This crosses
      // the old hardcoded 1500s cap and proves the single memory-safe shard
      // will not be false-killed merely because it owns the whole suite.
      for (let i = 0; i < 51; i++) {
        const file = join(TMPROOT, 'test', `memory-bound-${i}.test.ts`);
        writeFileSync(file, '');
        extraFiles.push(file);
      }

      const result = spawnSync(
        'bash',
        [join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), '--dry-run'],
        {
          cwd: TMPROOT,
          encoding: 'utf-8',
          env: {
            ...process.env,
            PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
            SHARDS: '',
          },
        },
      );

      expect(result.status).toBe(0);
      const windowsDefaultShards = Number(result.stderr.match(/N=(\d+) shards/)?.[1]);
      const discoveredFileCount = 55;
      const derivedShardTimeout = Number(result.stderr.match(/timeout=(\d+)s/)?.[1]);
      expect(windowsDefaultShards).toBe(1);
      expect(derivedShardTimeout).toBe(Math.max(discoveredFileCount * 30, 1500));
      expect(result.stderr).toContain('timeout=1650s (55 files/shard × 30s)');
    } finally {
      for (const file of extraFiles) rmSync(file, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('run-unit-parallel.sh stall watchdog', () => {
  it('reports an inner chunk timeout without calling the whole shard WEDGED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-chunk-timeout-'));
    const bun = join(dir, 'bun');
    const timeout = join(dir, 'timeout');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo win32; exit 0; fi
exit 124
`);
      writeFileSync(timeout, `#!/usr/bin/env bash
if [ "$1" = "--preserve-status" ]; then shift; fi
if [ "$1" = "--kill-after=5s" ]; then shift; fi
shift
"$@"
`);
      chmodSync(bun, 0o755);
      chmodSync(timeout, 0o755);

      const result = runWrapper([], {
        PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GBRAIN_TEST_SHARD_STALL_SECONDS: '0',
        GBRAIN_TEST_CHUNK_SIZE: '1',
        GBRAIN_TEST_CHUNK_TIMEOUT: '1',
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).not.toContain('WEDGED after');
      const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
      expect(summary).not.toContain('WEDGED after');
      expect(summary).toContain('rc=124');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('recursively kills the POSIX shard process tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-posix-tree-'));
    const bun = join(dir, 'bun');
    const childPid = join(dir, 'child.pid');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo linux; exit 0; fi
sleep 300 &
echo $! > "${childPid.replace(/\\/g, '/')}"
wait
`);
      chmodSync(bun, 0o755);

      const result = runWrapper([], {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        GBRAIN_TEST_SHARD_STALL_SECONDS: '2',
        GBRAIN_TEST_SHARD_STALL_POLL_SECONDS: '1',
        GBRAIN_TEST_SHARD_TIMEOUT: '9000',
        GBRAIN_TEST_CHUNK_SIZE: '1',
        GBRAIN_TEST_CHUNK_TIMEOUT: '0',
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('STALLED');
      const pid = Number(readFileSync(childPid, 'utf-8').trim());
      expect(isRunningNonZombie(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);


  it('never lets a completion marker override a nonzero shard verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-marker-nonzero-'));
    const bun = join(dir, 'bun');
    const shardScript = join(TMPROOT, 'scripts', 'run-unit-shard.sh');
    const originalShardScript = readFileSync(shardScript, 'utf-8');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo win32; exit 0; fi
printf ' 0 pass\n 1 fail\n 0 skip\n'
exit 1
`);
      chmodSync(bun, 0o755);
      const forgedShardScript = originalShardScript.replace(
        'exit "$worst"',
        'mark_completed\nexit "$worst"',
      );
      expect(forgedShardScript).not.toBe(originalShardScript);
      writeFileSync(shardScript, forgedShardScript);

      const result = runWrapper([], {
        PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GBRAIN_TEST_SHARD_STALL_SECONDS: '0',
        GBRAIN_TEST_SHARD_TIMEOUT: '9000',
        GBRAIN_TEST_CHUNK_SIZE: '4',
        GBRAIN_TEST_CHUNK_TIMEOUT: '0',
      });

      const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
      expect(result.code).not.toBe(0);
      expect(summary).toContain('fail=1');
      expect(summary).toMatch(/rc=(?!0)/);
    } finally {
      writeFileSync(shardScript, originalShardScript);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('treats recorded failures as fatal even if a shard reports rc=0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-fail-count-'));
    const bun = join(dir, 'bun');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo win32; exit 0; fi
printf ' 0 pass\n 1 fail\n 0 skip\n'
exit 0
`);
      chmodSync(bun, 0o755);

      const result = runWrapper([], {
        PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GBRAIN_TEST_SHARD_STALL_SECONDS: '0',
        GBRAIN_TEST_SHARD_TIMEOUT: '9000',
        GBRAIN_TEST_CHUNK_SIZE: '4',
        GBRAIN_TEST_CHUNK_TIMEOUT: '0',
      });

      const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
      expect(result.code).not.toBe(0);
      expect(summary).toContain('fail=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects rc=0 when the shard never attests natural completion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-missing-attestation-'));
    const bun = join(dir, 'bun');
    const shardScript = join(TMPROOT, 'scripts', 'run-unit-shard.sh');
    const originalShardScript = readFileSync(shardScript, 'utf-8');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo win32; exit 0; fi
printf ' 1 pass\n 0 fail\n 0 skip\n'
exit 0
`);
      chmodSync(bun, 0o755);
      const unattestedShardScript = originalShardScript
        .replace('[ "$rc" -ne 0 ] || mark_completed', 'true # suppress completion attestation')
        .replace('[ "$worst" -ne 0 ] || mark_completed', 'true # suppress completion attestation');
      expect(unattestedShardScript).not.toBe(originalShardScript);
      writeFileSync(shardScript, unattestedShardScript);
      rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));

      const result = runWrapper([], {
        PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GBRAIN_TEST_SHARD_STALL_SECONDS: '0',
        GBRAIN_TEST_SHARD_TIMEOUT: '9000',
        GBRAIN_TEST_CHUNK_SIZE: '4',
        GBRAIN_TEST_CHUNK_TIMEOUT: '0',
      });

      const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
      expect(result.code, `${result.stderr}\n${summary}`).not.toBe(0);
      expect(summary).toContain('UNATTESTED');
    } finally {
      writeFileSync(shardScript, originalShardScript);
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), `import { it, expect } from 'bun:test';\nit('fails', () => expect(1).toBe(2));\n`);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails closed when the wallclock helper kills after clean marker creation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-post-marker-race-'));
    const bun = join(dir, 'bun');
    const sleep = join(dir, 'sleep');
    const shardScript = join(TMPROOT, 'scripts', 'run-unit-shard.sh');
    const originalShardScript = readFileSync(shardScript, 'utf-8');
    const raceEntered = join(TMPROOT, '.context', 'post-marker-race-entered');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo win32; exit 0; fi
printf ' 1 pass\\n 0 fail\\n 0 skip\\n'
`);
      writeFileSync(sleep, `#!/usr/bin/env bash
if [ "$1" = "1" ]; then
  while [ ! -f "${raceEntered.replace(/\\/g, '/')}" ]; do /usr/bin/sleep 0.05; done
  exit 0
fi
exec /usr/bin/sleep "$@"
`);
      chmodSync(bun, 0o755);
      chmodSync(sleep, 0o755);
      const racedShardScript = originalShardScript.replace(
        '[ "$worst" -ne 0 ] || mark_completed\nexit "$worst"',
        `[ "$worst" -ne 0 ] || mark_completed\ntouch "${raceEntered.replace(/\\/g, '/')}"\nsleep 300\nexit "$worst"`,
      );
      expect(racedShardScript).not.toBe(originalShardScript);
      writeFileSync(shardScript, racedShardScript);
      rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));

      const result = runWrapper([], {
        PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GBRAIN_TEST_SHARD_STALL_SECONDS: '0',
        GBRAIN_TEST_SHARD_TIMEOUT: '1',
        GBRAIN_TEST_CHUNK_SIZE: '4',
        GBRAIN_TEST_CHUNK_TIMEOUT: '0',
      }, 30_000);

      expect(existsSync(raceEntered)).toBe(true);
      const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
      expect(result.code, `${result.stderr}\n${summary}`).not.toBe(0);
      expect(result.stderr).toContain('WEDGED');
      expect(summary).toContain('WEDGED');
    } finally {
      writeFileSync(shardScript, originalShardScript);
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), `import { it, expect } from 'bun:test';\nit('fails', () => expect(1).toBe(2));\n`);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('recursively terminates wallclock-helper descendants when pkill is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-helper-tree-'));
    const bun = join(dir, 'bun');
    const sleep = join(dir, 'sleep');
    const pkill = join(dir, 'pkill');
    const childPidFile = join(dir, 'helper-child.pid');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo win32; exit 0; fi
printf ' 1 pass\\n 0 fail\\n 0 skip\\n'
`);
      writeFileSync(sleep, `#!/usr/bin/env bash
if [ "$1" = "9000" ]; then
  /usr/bin/sleep 300 &
  child=$!
  native=$(ps -W 2>/dev/null | awk -v pid="$child" '$1 == pid { print $4; exit }')
  echo "\${native:-$child}" > "${childPidFile.replace(/\\/g, '/')}"
  wait "$child"
  exit $?
fi
exec /usr/bin/sleep "$@"
`);
      writeFileSync(pkill, '#!/usr/bin/env bash\nexit 127\n');
      chmodSync(bun, 0o755);
      chmodSync(sleep, 0o755);
      chmodSync(pkill, 0o755);
      rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));

      const result = runWrapper([], {
        PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GBRAIN_TEST_SHARD_STALL_SECONDS: '0',
        GBRAIN_TEST_SHARD_TIMEOUT: '9000',
        GBRAIN_TEST_CHUNK_SIZE: '4',
        GBRAIN_TEST_CHUNK_TIMEOUT: '0',
      }, 30_000);

      expect(result.code).toBe(0);
      expect(existsSync(childPidFile)).toBe(true);
      const childPid = readFileSync(childPidFile, 'utf-8').trim();
      expect(isRunningNonZombie(childPid)).toBe(false);
    } finally {
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), `import { it, expect } from 'bun:test';\nit('fails', () => expect(1).toBe(2));\n`);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('terminates the heartbeat sleep descendant without pkill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-heartbeat-tree-'));
    const bun = join(dir, 'bun');
    const sleep = join(dir, 'sleep');
    const pkill = join(dir, 'pkill');
    const heartbeatPidsFile = join(dir, 'heartbeat-owned.pids');
    const heartbeatReleaseFile = join(dir, 'heartbeat-release');
    const parallelScript = join(TMPROOT, 'scripts', 'run-unit-parallel.sh');
    const originalParallelScript = readFileSync(parallelScript, 'utf-8');
    let heartbeatPids: string[] = [];
    let child: ReturnType<typeof spawn> | undefined;

    try {
      const fixtureParallelScript = originalParallelScript.replace('    sleep 10\n', '    sleep 9001\n');
      expect(fixtureParallelScript).not.toBe(originalParallelScript);
      writeFileSync(parallelScript, fixtureParallelScript);

      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo win32; exit 0; fi
while [ ! -f "${heartbeatReleaseFile.replaceAll(String.fromCharCode(92), '/')}" ]; do /usr/bin/sleep 0.05; done
printf ' 1 pass\n 0 fail\n 0 skip\n'
`);
      writeFileSync(sleep, `#!/usr/bin/env bash
if [ "$1" = "9001" ]; then
  exec </dev/null >/dev/null 2>&1
  /usr/bin/sleep 300 &
  child=$!
  shell_native=$(ps -W 2>/dev/null | awk -v pid="$$" '$1 == pid { print $4; exit }')
  child_native=$(ps -W 2>/dev/null | awk -v pid="$child" '$1 == pid { print $4; exit }')
  printf '%s\n%s\n' "\${shell_native:-$$}" "\${child_native:-$child}" > "${heartbeatPidsFile.replaceAll(String.fromCharCode(92), '/')}"
  wait "$child"
  exit $?
fi
exec /usr/bin/sleep "$@"
`);
      writeFileSync(pkill, '#!/usr/bin/env bash\nexit 127\n');
      chmodSync(bun, 0o755);
      chmodSync(sleep, 0o755);
      chmodSync(pkill, 0o755);
      rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));

      child = spawn(
        'bash',
        [join(TMPROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '1'],
        {
          cwd: TMPROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
            GBRAIN_TEST_SHARD_STALL_SECONDS: '0',
            GBRAIN_TEST_SHARD_TIMEOUT: '9000',
            GBRAIN_TEST_CHUNK_SIZE: '4',
            GBRAIN_TEST_CHUNK_TIMEOUT: '0',
          },
        },
      );

      const deadline = Date.now() + 10_000;
      while (!existsSync(heartbeatPidsFile) && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      expect(existsSync(heartbeatPidsFile)).toBe(true);
      heartbeatPids = readFileSync(heartbeatPidsFile, 'utf-8').trim().split(/\s+/);
      expect(heartbeatPids.length).toBe(2);
      writeFileSync(heartbeatReleaseFile, 'go\n');

      const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult) => {
        let stderr = '';
        child!.stderr?.setEncoding('utf-8');
        child!.stderr?.on('data', (chunk) => { stderr += chunk; });
        child!.once('close', (code) => resolveResult({ code, stderr }));
      });
      expect(result.code, result.stderr).toBe(0);

      for (const pid of heartbeatPids) {
        expect(isRunningNonZombie(pid)).toBe(false);
      }
    } finally {
      if (child?.exitCode === null) child.kill('SIGKILL');
      for (const pid of heartbeatPids) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch {}
      }
      writeFileSync(parallelScript, originalParallelScript);
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), `import { it, expect } from 'bun:test';\nit('fails', () => expect(1).toBe(2));\n`);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not mark a shard stalled when it exits during the polling sleep', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-exit-race-'));
    const bun = join(dir, 'bun');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo win32; exit 0; fi
sleep 1
printf ' 1 pass\\n 0 fail\\n 0 skip\\n'
`);
      chmodSync(bun, 0o755);
      rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));

      const result = runWrapper([], {
        PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GBRAIN_TEST_SHARD_STALL_SECONDS: '1',
        GBRAIN_TEST_SHARD_STALL_POLL_SECONDS: '2',
        GBRAIN_TEST_SHARD_TIMEOUT: '9000',
        GBRAIN_TEST_CHUNK_SIZE: '1',
        GBRAIN_TEST_CHUNK_TIMEOUT: '0',
      });

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('STALLED');
    } finally {
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), `import { it, expect } from 'bun:test';\nit('fails', () => expect(1).toBe(2));\n`);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('kills a blocked shard shell after its Bun child has disappeared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-parallel-child-gone-'));
    const bun = join(dir, 'bun');
    const timeout = join(dir, 'timeout');
    const childGone = join(dir, 'bun-exited.txt');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo win32; exit 0; fi
exit 0
`);
      writeFileSync(timeout, `#!/usr/bin/env bash
if [ "$1" = "--preserve-status" ]; then shift; fi
if [ "$1" = "--kill-after=5s" ]; then shift; fi
shift
"$@"
touch "${childGone.replace(/\\/g, '/')}"
sleep 300
`);
      chmodSync(bun, 0o755);
      chmodSync(timeout, 0o755);

      const result = runWrapper([], {
        PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        GBRAIN_TEST_SHARD_STALL_SECONDS: '2',
        GBRAIN_TEST_SHARD_STALL_POLL_SECONDS: '1',
        GBRAIN_TEST_SHARD_TIMEOUT: '9000',
        GBRAIN_TEST_CHUNK_SIZE: '1',
        GBRAIN_TEST_CHUNK_TIMEOUT: '1',
      }, 120_000);

      expect(existsSync(childGone)).toBe(true);
      expect(result.stderr).toContain('STALLED');
      expect(result.code).not.toBe(-1);
      expect(result.code).not.toBe(0);
      const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
      expect(summary).toContain('STALLED after 2s with no output');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('run-unit-parallel.sh exit-code propagation (a)', () => {
  it('exits non-zero when any shard contains a failing test', () => {
    const r = runWrapper();
    expect(r.code).not.toBe(0);
  });

  it('exits zero when all shards pass (after removing the failing fixture)', () => {
    rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));
    try {
      const r = runWrapper();
      expect(r.code).toBe(0);
    } finally {
      // Restore the failing fixture for any downstream tests in the same
      // describe block (afterAll cleans the whole tempdir; this is belt-
      // and-suspenders).
      const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
    }
  });
});

describe('run-unit-parallel.sh failure-log contract (d)', () => {
  it('writes failures to .context/test-failures.log with --- shard prefix on failure', () => {
    const r = runWrapper();
    expect(r.code).not.toBe(0);

    const failureLog = join(TMPROOT, '.context/test-failures.log');
    expect(existsSync(failureLog)).toBe(true);
    const contents = readFileSync(failureLog, 'utf-8');
    expect(contents.length).toBeGreaterThan(0);
    expect(contents).toMatch(/--- shard \d+:/);
    expect(contents).toContain('failing-on-purpose');
  });

  it('prints loud stderr banner with absolute failure-log path on failure', () => {
    const r = runWrapper();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('TEST FAILURES');
    // Banner includes an absolute path so users can `cat` it directly. Under
    // MSYS/Git Bash, `pwd` spells the same Windows temp directory as /tmp/…;
    // accept either absolute notation rather than requiring Node's spelling.
    const nativePath = join(TMPROOT, '.context', 'test-failures.log');
    const posixPath = `${TMPROOT.replace(/\\/g, '/')}/.context/test-failures.log`;
    const msysAbsolute = /(?:^|\s)\/\S*\/\.context\/test-failures\.log/m;
    expect(
      r.stderr.includes(nativePath) ||
      r.stderr.includes(posixPath) ||
      msysAbsolute.test(r.stderr),
    ).toBe(true);
  });

  it('clears .context/test-failures.log to empty when all shards pass', () => {
    // Pre-seed a stale failure log to prove it gets cleared.
    mkdirSync(join(TMPROOT, '.context'), { recursive: true });
    writeFileSync(join(TMPROOT, '.context', 'test-failures.log'), 'STALE\n');
    rmSync(join(TMPROOT, 'test', 'd-fail.test.ts'));
    try {
      const r = runWrapper();
      expect(r.code).toBe(0);
      const contents = readFileSync(join(TMPROOT, '.context', 'test-failures.log'), 'utf-8');
      expect(contents).toBe('');
    } finally {
      const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
      writeFileSync(join(TMPROOT, 'test', 'd-fail.test.ts'), failing);
    }
  });

  it('writes per-shard summary lines to .context/test-summary.txt', () => {
    runWrapper();
    const summary = readFileSync(join(TMPROOT, '.context', 'test-summary.txt'), 'utf-8');
    // Format: `shard 1/2: pass=N fail=N skip=N rc=N`
    expect(summary).toMatch(/shard 1\/2: pass=\d+ fail=\d+ skip=\d+ rc=\d+/);
    expect(summary).toMatch(/shard 2\/2: pass=\d+ fail=\d+ skip=\d+ rc=\d+/);
  });
});

describe('run-unit-parallel.sh native temp fallback', () => {
  it('slash-normalizes Bun native temp paths for Git Bash', () => {
    const script = readFileSync(PARALLEL_SH_SRC, 'utf8');
    expect(script).toContain('tmpdir().replaceAll("\\\\\\\\", "/")');
    expect(script).toContain('RUN_ROOT="$HOST_TMP/gbrain-test-run-$$"');
    expect(script).not.toContain('RUN_ROOT="/tmp/');
  });
});

describe.skipIf(process.platform === 'win32')('run-unit-parallel.sh no-timeout-binary fallback (rc from shard wait, not watchdog teardown)', () => {
  // Forces the no-gtimeout/no-timeout branch by running the wrapper under a
  // curated PATH that has every tool the scripts call EXCEPT timeout
  // binaries (real `bun` symlinked in), so the fallback executes even on
  // hosts with coreutils installed. Windows cannot create these symlink
  // fixtures without Developer Mode, and its Git Bash process model cannot
  // exercise the POSIX watchdog contract faithfully, so this block skips there.
  //
  // Regression pinned here: the shard's sentinel .exit file must record the
  // exit code read right after `wait $pid` (the shard's own rc). The
  // watchdog subshell is killed with SIGTERM and reports 143; reading `$?`
  // after that teardown stamped rc=143 into every shard's sentinel — the
  // wrapper exited non-zero with rc=143 summaries even when every test
  // passed.
  let FROOT: string;
  let FENV: Record<string, string>;

  beforeAll(() => {
    FROOT = mkdtempSync(join(tmpdir(), 'gbrain-parallel-fallback-'));
    mkdirSync(join(FROOT, 'scripts'), { recursive: true });
    mkdirSync(join(FROOT, 'test'), { recursive: true });
    for (const s of ['run-unit-parallel.sh', 'run-unit-shard.sh', 'run-serial-tests.sh']) {
      copyFileSync(resolve(REPO_ROOT, 'scripts', s), join(FROOT, 'scripts', s));
      chmodSync(join(FROOT, 'scripts', s), 0o755);
    }
    const passing = `import { describe, it, expect } from 'bun:test';
describe('passing', () => {
  it('arithmetic works', () => { expect(1 + 1).toBe(2); });
});`;
    writeFileSync(join(FROOT, 'test', 'a-pass.test.ts'), passing);
    writeFileSync(join(FROOT, 'test', 'b-pass.test.ts'), passing);

    const bin = join(FROOT, 'bin');
    mkdirSync(bin);
    for (const tool of ['bash', 'sh', 'env', 'dirname', 'basename', 'mktemp', 'date', 'sleep', 'cat', 'tail', 'head', 'rm', 'mkdir', 'pkill', 'grep', 'sed', 'awk', 'wc', 'tr', 'seq', 'find', 'sort', 'bun']) {
      const p = Bun.which(tool);
      if (p) symlinkSync(p, join(bin, tool));
    }
    FENV = {
      PATH: bin,
      HOME: process.env.HOME ?? FROOT,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      GBRAIN_TEST_SHARD_TIMEOUT: '300',
    };
  });

  afterAll(() => {
    if (FROOT) rmSync(FROOT, { recursive: true, force: true });
  });

  function runFallbackWrapper(): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(
      'bash',
      [join(FROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '2'],
      { cwd: FROOT, encoding: 'utf-8', env: FENV },
    );
    return {
      code: result.status ?? -1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  it('exits zero with rc=0 shard sentinels when all shards pass', () => {
    const r = runFallbackWrapper();
    const summary = readFileSync(join(FROOT, '.context', 'test-summary.txt'), 'utf-8');
    expect(summary).toMatch(/shard 1\/2: pass=\d+ fail=0 skip=0 rc=0/);
    expect(summary).toMatch(/shard 2\/2: pass=\d+ fail=0 skip=0 rc=0/);
    expect(summary).not.toContain('rc=143');
    expect(r.code).toBe(0);
  });

  it('propagates a failing shard rc as the test runner rc (1), not the watchdog 143', () => {
    const failing = `import { describe, it, expect } from 'bun:test';
describe('failing-on-purpose', () => {
  it('expects 1 to equal 2', () => { expect(1).toBe(2); });
});`;
    writeFileSync(join(FROOT, 'test', 'z-fail.test.ts'), failing);
    try {
      const r = runFallbackWrapper();
      expect(r.code).not.toBe(0);
      const summary = readFileSync(join(FROOT, '.context', 'test-summary.txt'), 'utf-8');
      expect(summary).toMatch(/shard \d\/2: pass=\d+ fail=1 skip=0 rc=1/);
      expect(summary).not.toContain('rc=143');
      const failureLog = readFileSync(join(FROOT, '.context', 'test-failures.log'), 'utf-8');
      expect(failureLog).toContain('failing-on-purpose');
    } finally {
      rmSync(join(FROOT, 'test', 'z-fail.test.ts'), { force: true });
    }
  });
});
