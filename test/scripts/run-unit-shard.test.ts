/**
 * Regression test (b): scripts/run-unit-shard.sh exclusion symmetry.
 *
 * Pins the contract that the local fast-loop unit-shard script:
 *   1. EXCLUDES *.slow.test.ts (those run via scripts/run-slow-tests.sh).
 *   2. EXCLUDES *.serial.test.ts (those run via scripts/run-serial-tests.sh
 *      after the parallel pass).
 *   3. Includes plain *.test.ts files (the fast-loop unit set).
 *
 * Without this guard, a future refactor that drops one of the `-not -name`
 * clauses from the find expression would cause slow OR serial files to
 * run inside the parallel pass — silently undoing the quarantine and
 * re-introducing the contention flakes that motivated v0.26.4.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { delimiter, join, resolve } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(): string[] {
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

describe('run-unit-shard.sh Windows process bounds', () => {
  it('marks a naturally completed empty shard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unit-shard-empty-'));
    const completed = join(dir, 'completed');

    try {
      const result = spawnSync('bash', [SHARD_SH], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
          ...process.env,
          SHARD: '2000/2000',
          GBRAIN_TEST_SHARD_COMPLETED_FILE: completed,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(existsSync(completed)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not expose the supervisor completion marker to nested test processes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unit-shard-marker-private-'));
    const bun = join(dir, 'bun');
    const observed = join(dir, 'observed-marker.txt');
    const completed = join(dir, 'completed');

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then echo linux; exit 0; fi
printf '%s' "\${GBRAIN_TEST_SHARD_COMPLETED_FILE-unset}" > "${observed.replace(/\\/g, '/')}"
printf ' 1 pass\n 0 fail\n 0 skip\n'
`);
      chmodSync(bun, 0o755);

      const result = spawnSync('bash', [SHARD_SH], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
          SHARD: '1/2000',
          GBRAIN_TEST_SHARD_COMPLETED_FILE: completed,
          GBRAIN_TEST_CHUNK_SIZE: '0',
          GBRAIN_TEST_CHUNK_TIMEOUT: '0',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(observed, 'utf-8')).toBe('unset');
      expect(existsSync(completed)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('limits Windows Bun invocations to four files even if uname reports Linux', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unit-shard-'));
    const invocations = join(dir, 'bun-invocations.txt');
    const timeoutInvocations = join(dir, 'timeout-invocations.txt');
    const uname = join(dir, 'uname');
    const bun = join(dir, 'bun');
    const timeout = join(dir, 'timeout');

    try {
      writeFileSync(uname, '#!/usr/bin/env bash\necho Linux\n');
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then
  echo win32
  exit 0
fi
printf '%s\\n' "$*" >> "${invocations.replace(/\\/g, '/')}"
echo " 1 pass"
echo " 0 fail"
echo " 0 skip"
`);
      writeFileSync(timeout, `#!/usr/bin/env bash
if [ "$1" = "--preserve-status" ]; then shift; fi
if [ "$1" = "--kill-after=5s" ]; then shift; fi
printf '%s\\n' "$1" >> "${timeoutInvocations.replace(/\\/g, '/')}"
shift
"$@"
`);
      chmodSync(uname, 0o755);
      chmodSync(bun, 0o755);
      chmodSync(timeout, 0o755);

      execFileSync('bash', [SHARD_SH], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
          SHARD: '1/32',
          GBRAIN_TEST_CHUNK_SIZE: '',
        },
      });

      const calls = readFileSync(invocations, 'utf-8').trim().split('\n');
      const windowsDefaultChunkSize = Math.max(
        ...calls.map(call => (call.match(/test\/[^ ]+\.test\.ts/g) ?? []).length),
      );
      const timeoutCalls = readFileSync(timeoutInvocations, 'utf-8').trim().split('\n');
      const windowsDefaultChunkTimeout = Number(timeoutCalls[0]?.replace(/s$/, ''));
      expect(calls.length).toBeGreaterThan(1);
      expect(windowsDefaultChunkSize).toBe(4);
      // The cap is DERIVED from the chunk size (600s per file), never a flat
      // constant. It was a flat 300s — a 75s-per-file budget for a four-file
      // chunk — while a single Windows unit file that builds a PGLite engine
      // spends ~65s replaying migrations before its first assertion and
      // test/sync-monorepo.test.ts measures 389s alone. Assert the
      // relationship, not the number, so raising the chunk size can't
      // silently turn the cap back into a guaranteed kill.
      expect(windowsDefaultChunkTimeout).toBe(windowsDefaultChunkSize * 600);
      for (const call of calls) {
        expect((call.match(/test\/[^ ]+\.test\.ts/g) ?? []).length).toBeLessThanOrEqual(4);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scales the chunk cap with an explicit chunk size', () => {
    // The regression this pins: the cap used to be derived from the DEFAULT
    // chunk size, so raising GBRAIN_TEST_CHUNK_SIZE bought more files per bun
    // process without buying them any more wallclock — turning the cap into a
    // guaranteed kill that reports "totals lost" for every file in the chunk.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unit-shard-chunkcap-'));
    const timeoutInvocations = join(dir, 'timeout-invocations.txt');
    const uname = join(dir, 'uname');
    const bun = join(dir, 'bun');
    const timeout = join(dir, 'timeout');

    try {
      writeFileSync(uname, '#!/usr/bin/env bash\necho Linux\n');
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then
  echo win32
  exit 0
fi
echo " 1 pass"
echo " 0 fail"
echo " 0 skip"
`);
      writeFileSync(timeout, `#!/usr/bin/env bash
if [ "$1" = "--kill-after=5s" ]; then shift; fi
printf '%s\\n' "$1" >> "${timeoutInvocations.replace(/\\/g, '/')}"
shift
"$@"
`);
      chmodSync(uname, 0o755);
      chmodSync(bun, 0o755);
      chmodSync(timeout, 0o755);

      execFileSync('bash', [SHARD_SH], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
          SHARD: '1/500',
          GBRAIN_TEST_CHUNK_SIZE: '2',
          GBRAIN_TEST_CHUNK_SECONDS_PER_FILE: '600',
        },
      });

      const caps = readFileSync(timeoutInvocations, 'utf-8').trim().split('\n');
      expect(caps.length).toBeGreaterThan(0);
      for (const cap of caps) expect(cap).toBe('1200s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports its effective chunk cap for the wrapper to size bounds against', () => {
    // run-unit-parallel.sh sizes its stall window off this number instead of
    // hardcoding a copy of the chunk constants. Bun's reporter is silent for
    // a whole passing chunk, so a stall window shorter than the chunk cap
    // kills healthy shards; the two must be sized against each other, and the
    // only way to do that without drift is to ask the owner. Answering must
    // not require globbing the test tree, so it stays cheap to call.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unit-shard-cap-'));
    const uname = join(dir, 'uname');
    const bun = join(dir, 'bun');

    try {
      writeFileSync(uname, '#!/usr/bin/env bash\necho Linux\n');
      writeFileSync(bun, '#!/usr/bin/env bash\nif [ "$1" = "-e" ]; then echo win32; exit 0; fi\nexit 9\n');
      chmodSync(uname, 0o755);
      chmodSync(bun, 0o755);

      const run = (env: Record<string, string>) => spawnSync(
        'bash',
        [SHARD_SH, '--print-chunk-cap'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          timeout: 60_000,
          env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, ...env },
        },
      );

      const windowsDefault = run({ GBRAIN_TEST_CHUNK_SIZE: '' });
      expect(windowsDefault.status).toBe(0);
      expect(windowsDefault.stdout.trim()).toBe('2400');

      const biggerChunk = run({ GBRAIN_TEST_CHUNK_SIZE: '8' });
      expect(biggerChunk.stdout.trim()).toBe('4800');

      const pinned = run({ GBRAIN_TEST_CHUNK_TIMEOUT: '777' });
      expect(pinned.stdout.trim()).toBe('777');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a chunk size beyond Bash integer range', () => {
    const result = spawnSync('bash', [SHARD_SH], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 10_000,
      env: {
        ...process.env,
        SHARD: '1/200',
        GBRAIN_TEST_CHUNK_SIZE: '999999999999999999999999',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid GBRAIN_TEST_CHUNK_SIZE');
  });

  it('rejects a chunk timeout beyond Bash integer range', () => {
    const result = spawnSync('bash', [SHARD_SH], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 10_000,
      env: {
        ...process.env,
        SHARD: '1/200',
        GBRAIN_TEST_CHUNK_TIMEOUT: '999999999999999999999999',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid GBRAIN_TEST_CHUNK_TIMEOUT');
  });

  it('reports timeout diagnostics naming every file in a known multi-file chunk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unit-shard-single-chunk-'));
    const bun = join(dir, 'bun');
    const timeout = join(dir, 'timeout');
    const allFiles = dryRunList();
    const shardCount = Math.ceil(allFiles.length / 4);
    const selectedFiles = allFiles.filter((_, index) => index % shardCount === 0);

    expect(selectedFiles.length).toBeGreaterThan(1);
    expect(selectedFiles.length).toBeLessThanOrEqual(4);

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then
  echo win32
  exit 0
fi
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

      const result = spawnSync('bash', [SHARD_SH], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
          SHARD: `1/${shardCount}`,
          GBRAIN_TEST_CHUNK_SIZE: '4',
          GBRAIN_TEST_CHUNK_TIMEOUT: '1',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(124);
      expect(result.stderr).toContain('CHUNK 1 STALLED after 1s');
      for (const file of selectedFiles) {
        expect(result.stderr).toContain(`    ${file}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports crash diagnostics naming every file in a known multi-file chunk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unit-shard-single-crash-'));
    const bun = join(dir, 'bun');
    const allFiles = dryRunList();
    const shardCount = Math.ceil(allFiles.length / 4);
    const selectedFiles = allFiles.filter((_, index) => index % shardCount === 0);

    expect(selectedFiles.length).toBeGreaterThan(1);
    expect(selectedFiles.length).toBeLessThanOrEqual(4);

    try {
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then
  echo win32
  exit 0
fi
exit 127
`);
      chmodSync(bun, 0o755);

      const result = spawnSync('bash', [SHARD_SH], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
          SHARD: `1/${shardCount}`,
          GBRAIN_TEST_CHUNK_SIZE: '4',
          GBRAIN_TEST_CHUNK_TIMEOUT: '0',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(127);
      expect(result.stderr).toContain('CHUNK 1 CRASHED (rc=127');
      for (const file of selectedFiles) {
        expect(result.stderr).toContain(`    ${file}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hard-kills a TERM-resistant Bun chunk after the timeout grace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unit-shard-stall-'));
    const uname = join(dir, 'uname');
    const bun = join(dir, 'bun');
    const timeout = join(dir, 'timeout');

    try {
      writeFileSync(uname, '#!/usr/bin/env bash\necho Linux\n');
      writeFileSync(bun, `#!/usr/bin/env bash
if [ "$1" = "-e" ]; then
  echo win32
  exit 0
fi
trap '' TERM
sleep 30
`);
      // Hermetic substitute for timeout(1): require a bounded SIGKILL grace,
      // then model a child that ignores SIGTERM. Only the exact owned child is
      // signalled; the fixture never enumerates or targets unrelated processes.
      writeFileSync(timeout, `#!/usr/bin/env bash
kill_after="$1"
limit="$2"
shift 2
# Deliberately NOT --preserve-status: that flag makes a timed-out chunk exit
# with bun's own signal status (143 on TERM, 137 on KILL) instead of GNU
# timeout's 124/137, and report_chunk_failure keys on the latter. Asserting
# its absence here keeps the flag from being reintroduced silently.
if [ "$kill_after" != "--kill-after=5s" ] || [ "$limit" != "1s" ]; then
  echo "unexpected timeout args: $kill_after $limit" >&2
  exit 98
fi
"$@" &
pid=$!
sleep 1
kill -TERM "$pid" 2>/dev/null
sleep 0.1
if ! kill -0 "$pid" 2>/dev/null; then
  echo "fixture child did not resist SIGTERM" >&2
  exit 97
fi
kill -KILL "$pid" 2>/dev/null
wait "$pid" 2>/dev/null
exit 137
`);
      chmodSync(uname, 0o755);
      chmodSync(bun, 0o755);
      chmodSync(timeout, 0o755);

      const result = spawnSync('bash', [SHARD_SH], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
          SHARD: '1/2000',
          GBRAIN_TEST_CHUNK_SIZE: '',
          GBRAIN_TEST_CHUNK_TIMEOUT: '1',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(137);
      expect(result.stderr).toContain('CHUNK 1 FORCE-KILLED after 1s + 5s grace');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('run-unit-shard.sh exclusion symmetry', () => {
  it('lists at least one plain *.test.ts file', () => {
    const files = dryRunList();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => /\.test\.ts$/.test(f) && !/\.(slow|serial)\.test\.ts$/.test(f))).toBe(true);
  });

  it('excludes every *.slow.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.slow\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes every *.serial.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.serial\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes the test/e2e/ subtree', () => {
    const files = dryRunList();
    const leaks = files.filter(f => f.startsWith('test/e2e/'));
    expect(leaks).toEqual([]);
  });
});
