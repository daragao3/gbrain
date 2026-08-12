/**
 * `gbrain migrate` must not land its config flip on a config home that MOVED
 * underneath the run.
 *
 * Background: `saveConfig()` resolves GBRAIN_HOME at CALL time. A run that
 * outlives the env that launched it therefore writes whatever home is in
 * effect at the END — a test sets GBRAIN_HOME, starts a migration, hits its
 * timeout, and its cleanup deletes GBRAIN_HOME while the orphaned migration
 * promise keeps going and lands its `saveConfig` on the real machine-global
 * `~/.gbrain/config.json`, repointing the shared brain at the test's throwaway
 * target.
 *
 * `saveConfig` structurally CANNOT see this: it has no concept of run-start, so
 * by the time it runs the moved home is the only truth it has. The pin lives in
 * `runMigrateEngine`; `unsafeConfigFlipReason` is just the comparison.
 *
 * The sibling temp-target shape is NOT tested here — it lives in
 * `unsafeGlobalConfigWrite` (`config.ts`), covering every `saveConfig` caller
 * rather than this one, and is pinned in `gbrain-home-isolation.test.ts`.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { unsafeConfigFlipReason } from '../src/commands/migrate-engine.ts';
import { auditUnsafeConfigWrite, type GBrainConfig } from '../src/core/config.ts';

// Absolute so the comparison is platform-honest: on win32 these resolve onto
// the current drive, and both sides get the identical treatment.
const GLOBAL_CONFIG = resolve(sep, 'home', 'u', '.gbrain', 'config.json');
const SCOPED_CONFIG = resolve(sep, 'tmp', 'gbrain-migrate-home-abc123', '.gbrain', 'config.json');

describe('unsafeConfigFlipReason — a config home that moved mid-run is refused', () => {
  test('drift between run-start and flip time is refused', () => {
    const reason = unsafeConfigFlipReason(SCOPED_CONFIG, GLOBAL_CONFIG);
    expect(reason).not.toBeNull();
    expect(reason).toContain('changed mid-migration');
    // The message must name BOTH paths — the whole point is telling the
    // operator which home the run meant and which one it would have hit.
    expect(reason).toContain(SCOPED_CONFIG);
    expect(reason).toContain(GLOBAL_CONFIG);
  });

  test('an unchanged config path is the happy path', () => {
    expect(unsafeConfigFlipReason(GLOBAL_CONFIG, GLOBAL_CONFIG)).toBeNull();
  });

  test('a different spelling of the SAME directory is not drift', () => {
    // Canonicalization is what keeps this from firing spuriously: a trailing
    // separator, a mixed separator, or (on Windows) an 8.3 short name all name
    // the same file and must not read as a moved home.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-flip-guard-'));
    try {
      const a = join(dir, 'config.json');
      const b = join(dir + sep, 'config.json');
      expect(unsafeConfigFlipReason(a, b)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('drift is judged on the config path alone, not on the target', () => {
    // The temp-target question belongs to `unsafeGlobalConfigWrite`. This
    // function must stay a single-purpose comparison, so a perfectly permanent
    // target still trips it when the home moved...
    expect(unsafeConfigFlipReason(SCOPED_CONFIG, GLOBAL_CONFIG)).not.toBeNull();
    // ...and a throwaway-looking one does NOT trip it when the home held still.
    expect(unsafeConfigFlipReason(GLOBAL_CONFIG, GLOBAL_CONFIG)).toBeNull();
  });
});

describe('a drift refusal is recorded in the same audit trail', () => {
  let auditDir: string | null = null;
  const prevAudit = process.env.GBRAIN_AUDIT_DIR;

  afterEach(() => {
    if (prevAudit !== undefined) process.env.GBRAIN_AUDIT_DIR = prevAudit;
    else delete process.env.GBRAIN_AUDIT_DIR;
    if (auditDir) rmSync(auditDir, { recursive: true, force: true });
    auditDir = null;
  });

  test('writes a config-repoint-refused row discriminated by kind', () => {
    // Drift is the case where "which process did this?" is HARDEST to answer:
    // the run's launcher has already exited, so the in-process stack is the
    // only thing that names the offender. It must reach the same JSONL trail
    // the temp-target refusal writes, not a second private one.
    auditDir = mkdtempSync(join(tmpdir(), 'gbrain-flip-audit-'));
    process.env.GBRAIN_AUDIT_DIR = auditDir;

    const cfg: GBrainConfig = { engine: 'pglite', database_path: join(tmpdir(), 'x', 'brain.pglite') };
    const reason = unsafeConfigFlipReason(SCOPED_CONFIG, GLOBAL_CONFIG)!;
    auditUnsafeConfigWrite(cfg, reason, 'config_path_drift');

    const rowsPath = join(auditDir, 'config-repoint-refused.jsonl');
    expect(existsSync(rowsPath)).toBe(true);
    const lines = readFileSync(rowsPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const row = JSON.parse(lines[0]!);
    expect(row.event).toBe('refused_global_config_repoint');
    expect(row.kind).toBe('config_path_drift');
    expect(row.pid).toBe(process.pid);
    expect(row.reason).toContain('changed mid-migration');
    expect(typeof row.stack).toBe('string');
    expect(Number.isNaN(Date.parse(row.ts))).toBe(false);
  });
});
