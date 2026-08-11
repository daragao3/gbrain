/**
 * `gbrain migrate` must not repoint the ACTIVE config at a throwaway target.
 *
 * Background: `saveConfig()` resolves GBRAIN_HOME at CALL time, so the config
 * flip at the end of a migration writes whatever home is in effect then — the
 * machine-global `~/.gbrain/config.json` when GBRAIN_HOME is unset. Two ways
 * that has bitten this machine, both pinned here:
 *
 *   1. A migration whose target is a `%TEMP%` scratch dir. The temp store is
 *      deleted moments later and every subsequent CLI lookup returns
 *      `page_not_found` — indistinguishable from a genuinely deleted page.
 *   2. A run that outlives the env that launched it: a test sets GBRAIN_HOME,
 *      starts a migration, hits its timeout, and its cleanup deletes
 *      GBRAIN_HOME while the orphaned migration promise keeps going and lands
 *      its saveConfig on the real global config.
 *
 * `unsafeConfigFlipReason` is the gate for both. A migration to a PGLite brain
 * in a PERMANENT location must still be allowed — this is a tripwire, not a
 * policy — so that case is pinned too.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { unsafeConfigFlipReason } from '../src/commands/migrate-engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const SAME = '/home/u/.gbrain/config.json';

describe('unsafeConfigFlipReason — temp-dir targets are refused', () => {
  test('a database_path inside the OS temp dir is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-'));
    try {
      const cfg = { engine: 'pglite', database_path: join(dir, 'brain.pglite') } as GBrainConfig;
      const reason = unsafeConfigFlipReason(cfg, SAME, SAME, { gbrainHomeSet: false });
      expect(reason).not.toBeNull();
      expect(reason).toContain('temp directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the mkdtemp prefix is matched by name even if the path is not under tmpdir()', () => {
    // Defends the case where TMPDIR is redirected between the migration and
    // this check, so the containment test alone would miss it.
    const cfg = {
      engine: 'pglite',
      database_path: '/somewhere/else/gbrain-migrate-target-M72hsf/brain.pglite',
    } as GBrainConfig;
    expect(unsafeConfigFlipReason(cfg, SAME, SAME, { gbrainHomeSet: false })).not.toBeNull();
  });

  test('a PGLite brain in a permanent location is allowed', () => {
    const cfg = {
      engine: 'pglite',
      database_path: join('/home/u/.gbrain', 'brain.pglite'),
    } as GBrainConfig;
    expect(unsafeConfigFlipReason(cfg, SAME, SAME, { gbrainHomeSet: false })).toBeNull();
  });

  test('a postgres target carries no database_path and is allowed', () => {
    const cfg = {
      engine: 'postgres',
      database_url: 'postgres://user:pw@127.0.0.1:5437/gbrain_db',
    } as GBrainConfig;
    expect(unsafeConfigFlipReason(cfg, SAME, SAME, { gbrainHomeSet: false })).toBeNull();
  });

  test('under a GBRAIN_HOME a temp target is allowed — the config written is itself scoped', () => {
    // This is the hermetic shape the migrate tests use. Refusing it there would
    // break isolated runs without preventing any machine-global repoint.
    const cfg = {
      engine: 'pglite',
      database_path: join(tmpdir(), 'gbrain-migrate-target-x', 'brain.pglite'),
    } as GBrainConfig;
    expect(unsafeConfigFlipReason(cfg, SAME, SAME, { gbrainHomeSet: true })).toBeNull();
  });
});

describe('unsafeConfigFlipReason — a config home that moved mid-run is refused', () => {
  test('a changed config path is refused even when the target is permanent', () => {
    const cfg = {
      engine: 'pglite',
      database_path: '/home/u/.gbrain/brain.pglite',
    } as GBrainConfig;
    const reason = unsafeConfigFlipReason(
      cfg,
      '/tmp/gbrain-migrate-home-abc123/.gbrain/config.json', // GBRAIN_HOME at start
      '/home/u/.gbrain/config.json',                          // global, after cleanup
      { gbrainHomeSet: false },
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain('changed mid-migration');
  });

  test('drift is refused even under a GBRAIN_HOME — the scoping allowance must not bypass it', () => {
    // The scoped-config allowance is an early return; this pins that it sits
    // AFTER the drift check, so a moved config home is caught either way.
    const cfg = {
      engine: 'pglite',
      database_path: join(tmpdir(), 'gbrain-migrate-target-x', 'brain.pglite'),
    } as GBrainConfig;
    const reason = unsafeConfigFlipReason(
      cfg,
      '/tmp/gbrain-migrate-home-abc123/.gbrain/config.json',
      '/home/u/.gbrain/config.json',
      { gbrainHomeSet: true },
    );
    expect(reason).toContain('changed mid-migration');
  });

  test('an unchanged config path with a permanent target is the happy path', () => {
    const cfg = {
      engine: 'pglite',
      database_path: '/home/u/.gbrain/brain.pglite',
    } as GBrainConfig;
    expect(unsafeConfigFlipReason(cfg, SAME, SAME)).toBeNull();
  });
});
