/**
 * Regression test (e): scripts/run-serial-tests.sh discovery + concurrency=1.
 *
 * Pins the contract that:
 *   1. Every *.serial.test.ts file IS picked up by run-serial-tests.sh.
 *   2. The script invokes `bun test` with `--max-concurrency=1` (the
 *      serial-pass guarantee — quarantined files MUST NOT run intra-file
 *      concurrent or they reintroduce the contention flakes that
 *      motivated quarantining them).
 *   3. The serial set is DISJOINT from run-unit-shard.sh's set (a file
 *      cannot run in both passes; the unit-shard test pins one half,
 *      this test pins the other).
 *   4. Positional FILE arguments select an explicit subset, and an
 *      unusable path is rejected loudly instead of being discarded.
 *      Before this was supported the script IGNORED positional args and
 *      silently ran the whole ~95-file sweep (~1h) — the only tell was
 *      its own "running 95 file(s)" banner.
 *
 * Without these guards, a refactor of either runner could silently let
 * .serial files run alongside the parallel pass (= contention flakes)
 * or be skipped entirely (= no test coverage at all).
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SERIAL_SH = resolve(REPO_ROOT, 'scripts/run-serial-tests.sh');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(scriptPath: string, args: string[] = []): string[] {
  const out = execFileSync('bash', [scriptPath, '--dry-run-list', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function runSerial(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SERIAL_SH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('run-serial-tests.sh contract', () => {
  it('discovers every *.serial.test.ts file', () => {
    const serialFiles = dryRunList(SERIAL_SH);
    // Every file the script lists must end in .serial.test.ts.
    const offenders = serialFiles.filter(f => !/\.serial\.test\.ts$/.test(f));
    expect(offenders).toEqual([]);

    // Every checked-in *.serial.test.ts must be listed by the script.
    // We cross-check by globbing through git ls-files (deterministic; doesn't
    // depend on filesystem state during the test run).
    const tracked = execFileSync('git', ['ls-files', 'test'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
      .split('\n')
      .map(s => s.trim())
      .filter(f => /\.serial\.test\.ts$/.test(f) && !f.startsWith('test/e2e/'));
    for (const f of tracked) {
      expect(serialFiles).toContain(f);
    }
  });

  it('passes --max-concurrency=1 to bun test', () => {
    const src = readFileSync(SERIAL_SH, 'utf-8');
    expect(src).toMatch(/bun test\s+--max-concurrency=1/);
  });

  it('builds the gitignored snapshot fixture when stale and extends only its timeout', () => {
    const src = readFileSync(SERIAL_SH, 'utf-8');
    expect(src).toMatch(/test_timeout=60000/);
    // The build must stay conditional (--if-stale), not unconditional. The test
    // throws `snapshot fixture stale` at module scope and cannot degrade to a
    // cold init, so the rebuild has to remain guaranteed — but rebuilding an
    // already-current fixture costs a full PGLite boot plus ~120 migrations on
    // every run. --if-stale keeps the guarantee and makes the common case a no-op.
    expect(src).toMatch(
      /test\/pglite-snapshot-file-seeding\.serial\.test\.ts[\s\S]*test_timeout=900000[\s\S]*bun run scripts\/build-pglite-snapshot\.ts --if-stale/,
    );
    expect(src).not.toMatch(/bun run build:pglite-snapshot\b/);
    expect(src).toMatch(/--timeout="\$test_timeout"/);
  });

  it('disjoint from run-unit-shard.sh (a file is never in both passes)', () => {
    const serialFiles = new Set(dryRunList(SERIAL_SH));
    const unitFiles = new Set(dryRunList(SHARD_SH));
    const overlap = [...serialFiles].filter(f => unitFiles.has(f));
    expect(overlap).toEqual([]);
  });
});

describe('run-serial-tests.sh file selection', () => {
  const SNAPSHOT_FILE = 'test/pglite-snapshot-file-seeding.serial.test.ts';

  it('runs every serial file when given no positional arguments', () => {
    // The mode `bun run test:serial` and run-unit-parallel.sh depend on.
    const all = dryRunList(SERIAL_SH);
    expect(all.length).toBeGreaterThan(1);
    expect(all).toContain(SNAPSHOT_FILE);
  });

  it('narrows to exactly the named file(s) when positional arguments are given', () => {
    const one = dryRunList(SERIAL_SH, [SNAPSHOT_FILE]);
    expect(one).toEqual([SNAPSHOT_FILE]);

    const others = dryRunList(SERIAL_SH).filter(f => f !== SNAPSHOT_FILE);
    expect(others.length).toBeGreaterThan(0);
    const two = dryRunList(SERIAL_SH, [SNAPSHOT_FILE, others[0]]);
    expect(new Set(two)).toEqual(new Set([SNAPSHOT_FILE, others[0]]));
  });

  it('strips a leading ./ so per-file special cases still match', () => {
    expect(dryRunList(SERIAL_SH, [`./${SNAPSHOT_FILE}`])).toEqual([SNAPSHOT_FILE]);
  });

  it('accepts positional arguments before or after --dry-run-list', () => {
    const after = dryRunList(SERIAL_SH, [SNAPSHOT_FILE]);
    const before = runSerial([SNAPSHOT_FILE, '--dry-run-list']);
    expect(before.status).toBe(0);
    expect(before.stdout.split('\n').map(s => s.trim()).filter(Boolean)).toEqual(after);
  });

  it('exits 2 and names the path when a positional file does not exist', () => {
    const r = runSerial(['--dry-run-list', 'test/does-not-exist.serial.test.ts']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('test/does-not-exist.serial.test.ts');
    expect(r.stdout).not.toContain('.serial.test.ts');
  });

  it('exits 2 when a positional file is not a *.serial.test.ts path', () => {
    const r = runSerial(['--dry-run-list', 'test/migrate.test.ts']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('test/migrate.test.ts');
  });

  it('exits 2 on an unknown flag rather than treating it as a file', () => {
    const r = runSerial(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--bogus');
  });

  it('applies the per-file snapshot special case to the selected list, not the glob', () => {
    // The 900000ms timeout + fixture build must fire when the snapshot file is
    // named explicitly, so the special case has to live inside the loop over
    // the RESOLVED file list (which selection replaces) — not beside the find.
    const src = readFileSync(SERIAL_SH, 'utf-8');
    const loopAt = src.indexOf('for f in "${files[@]}"');
    const specialAt = src.indexOf(SNAPSHOT_FILE);
    expect(loopAt).toBeGreaterThan(-1);
    expect(specialAt).toBeGreaterThan(loopAt);
  });
});
