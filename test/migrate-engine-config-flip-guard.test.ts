/**
 * `gbrain migrate` must not repoint the ACTIVE config at a target the operator
 * never chose.
 *
 * Background: `saveConfig()` resolves GBRAIN_HOME at CALL time, so the config
 * flip at the end of a migration writes whatever home is in effect then — the
 * machine-global `~/.gbrain/config.json` when GBRAIN_HOME is unset. Once that
 * lands on a throwaway store, every later `gbrain` read returns
 * `page_not_found` against an empty brain with no error: a silent false
 * negative indistinguishable from a genuinely deleted page.
 *
 * TWO GUARDS, ONE PREDICATE EACH, AND THEY DO NOT OVERLAP:
 *
 *   - The THROWAWAY-TARGET shape lives in `saveConfig` itself
 *     (`unsafeGlobalConfigWrite`), so it protects every caller rather than
 *     this one. Its coverage — temp containment, Windows 8.3 short names, the
 *     `gbrain-migrate-target-*` prefix, GBRAIN_HOME, GBRAIN_ALLOW_TEMP_BRAIN —
 *     is pinned in `gbrain-home-isolation.test.ts` and deliberately NOT
 *     re-tested here. What IS pinned here is that migrate routes through it.
 *
 *   - The CONFIG-HOME-MOVED-MID-RUN shape is migrate's own, because it needs a
 *     value pinned at command entry that `saveConfig` cannot know. Concretely:
 *     a test sets GBRAIN_HOME, starts a migration, hits its timeout, and its
 *     cleanup deletes GBRAIN_HOME while the orphaned migration promise keeps
 *     going and lands its saveConfig on the real global config. The target may
 *     be perfectly durable, so nothing about the config being written looks
 *     wrong — only the fact that the DESTINATION moved gives it away.
 *
 * Disposition note: migrate WITHHOLDS the flip (warning + non-zero exit
 * verdict) rather than letting `saveConfig` throw, because the data migration
 * has already completed by that point and aborting would misreport a run whose
 * data half succeeded. That branch is exercised by `runMigrateEngine`, which
 * needs a live engine pair; these tests cover the predicate that drives it.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { configPathDriftReason, configFlipRefusalReason } from '../src/commands/migrate-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const SAME = resolve(sep, 'home', 'u', '.gbrain', 'config.json');
const DURABLE = resolve(sep, 'home', 'u', '.gbrain', 'brain.pglite');

describe('configPathDriftReason — a config home that moved mid-run', () => {
  test('an unchanged config path is the happy path', () => {
    expect(configPathDriftReason(SAME, SAME)).toBeNull();
  });

  test('a changed config path is refused', () => {
    const reason = configPathDriftReason(
      resolve(sep, 'tmp', 'gbrain-migrate-home-abc123', '.gbrain', 'config.json'), // GBRAIN_HOME at start
      SAME,                                                                         // global, after cleanup
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain('changed mid-migration');
    // The message must name BOTH ends — "something moved" is not actionable.
    expect(reason).toContain('gbrain-migrate-home-abc123');
    expect(reason).toContain(SAME);
  });

  test('an equivalent respelling of the same directory is NOT a move', () => {
    // Canonicalization guards against a false refusal: a trailing separator or
    // a redundant `.` segment is the same destination, and refusing there would
    // break legitimate migrations for no safety gain.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-drift-respell-'));
    try {
      const plain = join(dir, 'config.json');
      const noisy = join(dir, '.', 'config.json') + '';
      expect(configPathDriftReason(plain, noisy)).toBeNull();
      expect(configPathDriftReason(join(dir + sep, 'config.json'), plain)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('configFlipRefusalReason — migrate routes through BOTH guards', () => {
  test('a durable target with a steady config path is allowed', () => {
    const cfg = { engine: 'pglite', database_path: DURABLE } as GBrainConfig;
    expect(configFlipRefusalReason(cfg, SAME, SAME)).toBeNull();
  });

  test('a postgres target carries no database_path and is allowed', () => {
    const cfg = {
      engine: 'postgres',
      database_url: 'postgres://user:pw@127.0.0.1:5437/gbrain_db',
    } as GBrainConfig;
    expect(configFlipRefusalReason(cfg, SAME, SAME)).toBeNull();
  });

  test('drift is refused even when the target is perfectly durable', () => {
    // The half `unsafeGlobalConfigWrite` structurally cannot catch: nothing
    // about this config is suspicious, only where it would be written.
    const cfg = { engine: 'pglite', database_path: DURABLE } as GBrainConfig;
    const reason = configFlipRefusalReason(
      cfg,
      resolve(sep, 'tmp', 'gbrain-migrate-home-abc123', '.gbrain', 'config.json'),
      SAME,
    );
    expect(reason).toContain('changed mid-migration');
  });

  test('a throwaway target is refused via the shared saveConfig predicate', async () => {
    // Pins the WIRING, not the predicate — that migrate consults
    // `unsafeGlobalConfigWrite` rather than carrying its own copy of the
    // throwaway test. The shapes themselves are covered in
    // gbrain-home-isolation.test.ts.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-'));
    try {
      await withEnv({ GBRAIN_HOME: undefined, GBRAIN_ALLOW_TEMP_BRAIN: undefined }, () => {
        const cfg = { engine: 'pglite', database_path: join(dir, 'brain.pglite') } as GBrainConfig;
        expect(configFlipRefusalReason(cfg, SAME, SAME)).not.toBeNull();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('under a GBRAIN_HOME a temp target is allowed — the config written is itself scoped', async () => {
    // The hermetic shape the migrate tests use. Refusing it would break
    // legitimate isolated runs without preventing any machine-global repoint.
    const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    try {
      await withEnv({ GBRAIN_HOME: sandbox }, () => {
        const cfg = {
          engine: 'pglite',
          database_path: join(tmpdir(), 'gbrain-migrate-target-x', 'brain.pglite'),
        } as GBrainConfig;
        expect(configFlipRefusalReason(cfg, SAME, SAME)).toBeNull();
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('drift is refused even under a GBRAIN_HOME — the scoping allowance must not bypass it', async () => {
    // `unsafeGlobalConfigWrite` returns null early when GBRAIN_HOME is set.
    // This pins that the drift predicate is still consulted after it, so a
    // moved config home is caught either way.
    const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    try {
      await withEnv({ GBRAIN_HOME: sandbox }, () => {
        const cfg = {
          engine: 'pglite',
          database_path: join(tmpdir(), 'gbrain-migrate-target-x', 'brain.pglite'),
        } as GBrainConfig;
        const reason = configFlipRefusalReason(
          cfg,
          resolve(sep, 'tmp', 'gbrain-migrate-home-abc123', '.gbrain', 'config.json'),
          SAME,
        );
        expect(reason).toContain('changed mid-migration');
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
