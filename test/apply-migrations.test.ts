/**
 * Tests for `gbrain apply-migrations` — the migration runner CLI.
 *
 * Unit-scope: exercises the pure helpers (parseArgs, indexCompleted, buildPlan,
 * statusForVersion). End-to-end integration against real orchestrators is
 * covered by test/e2e/migration-flow.test.ts (Lane C-5).
 */

import { describe, test, expect } from 'bun:test';
import { __testing } from '../src/commands/apply-migrations.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';

const { parseArgs, indexCompleted, buildPlan, statusForVersion, formatFailedPhases } = __testing;

describe('parseArgs', () => {
  test('default flags', () => {
    const a = parseArgs([]);
    expect(a.list).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.yes).toBe(false);
    expect(a.nonInteractive).toBe(false);
    expect(a.mode).toBeUndefined();
    expect(a.specificMigration).toBeUndefined();
    expect(a.hostDir).toBeUndefined();
    expect(a.noAutopilotInstall).toBe(false);
  });

  test('--list / --dry-run / --yes / --non-interactive', () => {
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--yes']).yes).toBe(true);
    expect(parseArgs(['--non-interactive']).nonInteractive).toBe(true);
  });

  test('--mode accepts valid values', () => {
    expect(parseArgs(['--mode', 'always']).mode).toBe('always');
    expect(parseArgs(['--mode', 'pain_triggered']).mode).toBe('pain_triggered');
    expect(parseArgs(['--mode', 'off']).mode).toBe('off');
  });

  test('--migration and --host-dir parse values', () => {
    const a = parseArgs(['--migration', '0.11.0', '--host-dir', '/tmp/abc']);
    expect(a.specificMigration).toBe('0.11.0');
    expect(a.hostDir).toBe('/tmp/abc');
  });

  test('--no-autopilot-install flips flag', () => {
    expect(parseArgs(['--no-autopilot-install']).noAutopilotInstall).toBe(true);
  });

  test('--help sets help flag', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('indexCompleted + statusForVersion', () => {
  test('no entries → pending', () => {
    const idx = indexCompleted([]);
    expect(statusForVersion('0.11.0', idx)).toBe('pending');
  });

  test('one complete entry → complete', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'complete', mode: 'always' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('complete');
  });

  test('only partial entries → partial', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('partial');
  });

  test('partial then complete → complete (stopgap then v0.11.1 apply-migrations)', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
      { version: '0.11.0', status: 'complete', mode: 'always' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('complete');
  });

  test('only looks at the queried version', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.10.0', status: 'complete' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('pending');
    expect(statusForVersion('0.10.0', idx)).toBe('complete');
  });
});

describe('buildPlan — diff against completed + installed VERSION', () => {
  test('fresh install (no entries) — v0.11.0 is pending when installed ≥ 0.11.0', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.applied).toEqual([]);
    expect(plan.partial).toEqual([]);
    expect(plan.pending.map(m => m.version)).toContain('0.11.0');
    // Future migrations (registered but newer than installed VERSION) land in
    // skippedFuture until the binary catches up. v0.13.0 = frontmatter graph,
    // v0.13.1 = Knowledge Runtime grandfather, v0.14.0 = shell jobs +
    // autopilot cooperative, v0.16.0 = subagent runtime, v0.18.0 = multi-
    // source brains, v0.18.1 = RLS hardening, v0.21.0 = Cathedral II
    // (renumbered from v0.20.0 after master shipped v0.20.x in parallel).
    expect(plan.skippedFuture.map(m => m.version)).toEqual(['0.12.0', '0.12.2', '0.13.0', '0.13.1', '0.14.0', '0.16.0', '0.18.0', '0.18.1', '0.21.0', '0.22.4', '0.28.0', '0.29.1', '0.31.0', '0.32.2']);
  });

  test('already applied → v0.11.0 lands in `applied` bucket, not pending', () => {
    const idx = indexCompleted([{ version: '0.11.0', status: 'complete' }]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.applied.map(m => m.version)).toContain('0.11.0');
    expect(plan.pending).toEqual([]);
  });

  test('stopgap wrote partial → v0.11.0 lands in `partial` bucket (resumable)', () => {
    const idx = indexCompleted([
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
    ]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.partial.map(m => m.version)).toContain('0.11.0');
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual([]);
  });

  test('Codex H9 regression: installed older than migration → skippedFuture, not skipped silently', () => {
    // Running a v0.10.x binary that somehow loaded a v0.11.0 migration registry:
    // migration is skippedFuture (wait for a newer install), NOT ignored.
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.10.5');
    expect(plan.skippedFuture.map(m => m.version)).toContain('0.11.0');
    expect(plan.pending).toEqual([]);
  });

  test('Codex H9 regression: installed > migration version → still runs (not skipped)', () => {
    // This is the critical bug Codex caught: the plan was "apply when version >
    // installed", which would SKIP v0.11.0 when running v0.11.1. The correct
    // rule is "apply when not in completed.jsonl AND version ≤ installed".
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.12.0');
    expect(plan.pending.map(m => m.version)).toContain('0.11.0');
    // v0.12.2, v0.13.0, v0.13.1, v0.14.0, v0.16.0, v0.18.0, v0.18.1, v0.21.0,
    // v0.22.4, v0.28.0, v0.29.1, v0.31.0 were added later; installed=0.12.0
    // means they belong in skippedFuture, not pending. v0.11.0 and v0.12.0
    // stay pending despite being ≤ installed — that is the H9 invariant.
    expect(plan.skippedFuture.map(m => m.version)).toEqual(['0.12.2', '0.13.0', '0.13.1', '0.14.0', '0.16.0', '0.18.0', '0.18.1', '0.21.0', '0.22.4', '0.28.0', '0.29.1', '0.31.0', '0.32.2']);
  });

  test('--migration filter narrows to one version', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1', '0.11.0');
    expect(plan.pending.map(m => m.version)).toEqual(['0.11.0']);
  });

  test('--migration filter for unknown version → empty plan', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1', '99.99.99');
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual([]);
    expect(plan.partial).toEqual([]);
    expect(plan.skippedFuture).toEqual([]);
  });
});

// v0.36.1.x (cherry-pick #1062): list, dry-run, and "all migrations up to
// date" paths must exit 0 so shell scripts gating on the exit code work.
// Pre-fix, these `return` statements left the CLI dispatcher's implicit
// non-zero exit code in place when callers checked $?.
describe('runApplyMigrations exit codes (v0.36.1.x #1062)', () => {
  test('source contains process.exit(0) on list/dry-run/up-to-date branches', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/apply-migrations.ts', 'utf8');
    expect(src).toMatch(/cli\.list\s*\)\s*\{\s*printList\(plan,\s*installed\);\s*process\.exit\(0\);/);
    expect(src).toMatch(/cli\.dryRun\s*\)\s*\{\s*printDryRun\(plan,\s*installed\);\s*process\.exit\(0\);/);
    expect(src).toMatch(/All migrations up to date[\s\S]{0,80}process\.exit\(0\)/);
  });
});

// A PARTIAL banner used to name the migration and nothing else. The phase that
// actually failed (and its detail) went straight to completed.jsonl, so the
// only way to learn WHICH phase broke was to re-run every subprocess the
// orchestrator shells out to by hand. formatFailedPhases surfaces it.
describe('formatFailedPhases', () => {
  test('no phases → null (caller prints no header)', () => {
    expect(formatFailedPhases(undefined)).toBeNull();
    expect(formatFailedPhases([])).toBeNull();
  });

  test('all phases complete/skipped → null', () => {
    expect(formatFailedPhases([
      { name: 'schema', status: 'complete' },
      { name: 'backfill_links', status: 'skipped', detail: 'auto_link disabled' },
    ])).toBeNull();
  });

  test('one failed phase → name and detail', () => {
    expect(formatFailedPhases([
      { name: 'schema', status: 'complete' },
      { name: 'verify', status: 'failed', detail: 'could not read gbrain stats' },
    ])).toBe('Failed phase(s):\n  - verify — could not read gbrain stats');
  });

  test('only failed phases are listed, complete/skipped are dropped', () => {
    const out = formatFailedPhases([
      { name: 'schema', status: 'complete', detail: 'already applied' },
      { name: 'backfill_links', status: 'failed', detail: 'timed out after 600000ms' },
      { name: 'backfill_timeline', status: 'skipped', detail: 'dry-run' },
      { name: 'verify', status: 'failed', detail: 'could not read gbrain stats' },
    ]);
    expect(out).toBe(
      'Failed phase(s):\n' +
      '  - backfill_links — timed out after 600000ms\n' +
      '  - verify — could not read gbrain stats',
    );
    expect(out).not.toContain('schema');
    expect(out).not.toContain('backfill_timeline');
  });

  test('missing or blank detail → bare phase name, no dangling separator', () => {
    expect(formatFailedPhases([{ name: 'verify', status: 'failed' }]))
      .toBe('Failed phase(s):\n  - verify');
    expect(formatFailedPhases([{ name: 'verify', status: 'failed', detail: '   ' }]))
      .toBe('Failed phase(s):\n  - verify');
  });

  test('detail is trimmed (subprocess errors arrive with trailing newlines)', () => {
    expect(formatFailedPhases([
      { name: 'backfill_links', status: 'failed', detail: '  command failed: exit 1\n' },
    ])).toBe('Failed phase(s):\n  - backfill_links — command failed: exit 1');
  });
});

// The formatter is only useful if the runner actually calls it. These pin the
// wiring at all three terminal paths, which a unit test of the pure function
// cannot reach (the loop lives inside runApplyMigrations, behind a real
// orchestrator + ledger writes).
describe('runApplyMigrations surfaces failed phases', () => {
  test('partial, status=failed, and throw paths all report the failed phases', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/apply-migrations.ts', 'utf8');

    // PARTIAL banner is followed by the failed-phase report.
    expect(src).toMatch(/finished as PARTIAL[\s\S]{0,200}formatFailedPhases\(result\.phases\)/);
    // The existing #921 status=failed diagnostics now share the formatter.
    expect(src).toMatch(/reported status=failed[\s\S]{0,200}formatFailedPhases\(result\.phases\)/);
    // Throw path has no result object, so it synthesizes a phase and persists
    // it — the ledger entry used to be a bare `partial` with no reason at all.
    expect(src).toMatch(/threw:[\s\S]{0,600}name: 'orchestrator', status: 'failed', detail: msg/);
    expect(src).toMatch(/status: 'partial', phases: thrownPhases/);
  });
});
