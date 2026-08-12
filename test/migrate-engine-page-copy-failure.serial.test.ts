/**
 * #3194 — `gbrain migrate` must not silently drop pages while reporting
 * success.
 *
 * Two things are pinned here:
 *
 *  1. `copyPageToTarget` normalizes JS `undefined` column values to an
 *     explicit `null` before handing them to `target.putPage`. PGLite can
 *     hand back `undefined` for a column that is legitimately NULL/empty;
 *     postgres.js's `UNDEFINED_VALUE` guard rejects a raw `undefined` bound
 *     parameter (but accepts `null` fine). Without this normalization, a
 *     migrated page carrying an `undefined` field throws mid-insert.
 *
 *  2. `runMigrateEngine`'s per-page copy loop must not let an unrecoverable
 *     per-page failure disappear into the success count: the failed page
 *     must be excluded from the resume manifest's `completed_slugs` (so a
 *     retry picks it back up) and the run must end with a non-zero CLI exit
 *     verdict instead of looking identical to a clean migration.
 */

import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copyPageToTarget, runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { saveConfig, loadConfigFileOnly } from '../src/core/config.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';
import { useSnapshotPglite } from './helpers/snapshot-pglite.ts';

/**
 * Tier-3 snapshot opt-in (self-contained).
 *
 * Every migrate test below cold-boots several PGLite clusters, two of which
 * run `PGLITE_SCHEMA_SQL` + the full migration ladder. `initSchema()` alone
 * measured 6.5s per cluster on an idle machine (121 migrations) and ~14s
 * under load, which is what pushed these tests past a 30s budget.
 *
 * Loading the snapshot replaces that ladder with a tarball restore. Measured
 * with an interleaved A/B (ON/OFF/ON/OFF in ONE process, so a load trend hits
 * both arms equally — non-interleaved runs on this box are uncomparable, see
 * the timeout note below): one in-memory + one fresh file-backed cluster cost
 * 36.2s avg with the snapshot vs 71.9s without. Both reps agreed. ~2x.
 *
 * `scripts/ci-local.sh` exports `GBRAIN_PGLITE_SNAPSHOT` for the whole suite,
 * but a bare `bun test test/migrate-engine-page-copy-failure.serial.test.ts`
 * inherits nothing — which is exactly how these tests are usually run when
 * they're being debugged. So opt in here instead of depending on ambient env.
 *
 * The fixture is gitignored and built on demand, so it is legitimately absent
 * on a fresh clone. Absent (or hash-stale) => `tryLoadSnapshot` returns null
 * and the engine silently falls back to a normal cold init: slower, but still
 * correct. That is why this only ever SETS the vars, never asserts on them.
 *
 * `seedFileBacked` additionally lets the FILE-BACKED migration target skip its
 * own init. It is honoured only for a dataDir that holds no cluster yet, and
 * a snapshot-seeded target is schema-only — 0 pages — so the "target brain is
 * not empty" guard (which counts pages) still sees it as empty.
 *
 * This goes through `useSnapshotPglite()` rather than a module-level
 * `process.env` assignment. `process.env` is process-global, and a bare
 * assignment here would leak into every file loaded after this one in the same
 * bun process — order-dependently, reshuffling whenever a test file is added.
 * Leaking the seed-file flag is the worse half: it changes what a fresh
 * on-disk brain looks like at connect() time, which would silently alter any
 * later file asserting on fresh-install state.
 *
 * To be precise about the blast radius here: `scripts/run-serial-tests.sh`
 * gives each `*.serial.test.ts` its OWN bun process, so via that runner the
 * leak is not reachable from this file — the bracket is defensive, matching
 * the convention rather than repairing a live escape. It does matter for a
 * developer running `bun test <this file> <other files>` directly, which is
 * exactly how these tests get exercised while being debugged. See
 * `test/helpers/cold-pglite.ts` for the same reasoning in the opt-OUT
 * direction, where the leak WAS live and cost 3 of 4 unit shards the snapshot.
 */
useSnapshotPglite({ seedFileBacked: true });

/**
 * In-flight `runMigrateEngine` calls, drained by `afterEach` BEFORE any
 * `GBRAIN_HOME` restoration happens.
 *
 * This is the load-bearing half of the data-integrity fix, and it is not
 * about speed. `saveConfig()` resolves `GBRAIN_HOME` at CALL time. If a test
 * is aborted at its timeout while suspended inside `runMigrateEngine`, the
 * test body's `finally` (or simply the next test / end of file) clears
 * `GBRAIN_HOME` while that promise is still running. The orphan then reaches
 * `saveConfig()` with no `GBRAIN_HOME` in effect and rewrites the
 * MACHINE-GLOBAL `~/.gbrain/config.json`, repointing the operator's real
 * brain at a %TEMP% PGLite store that is deleted moments later — after which
 * every lookup returns page_not_found, indistinguishable from a deleted page.
 *
 * Registering the promise here and awaiting it in `afterEach` means the env
 * is never torn down underneath a live run, regardless of timing. gbrain
 * commit 01e4a4fe (`unsafeConfigFlipReason`) refuses the resulting write as a
 * second line of defence; this closes the window that produces it at all.
 */
const inFlightMigrations = new Set<Promise<unknown>>();

function trackedMigrate(source: BrainEngine, args: string[]): Promise<unknown> {
  const run = runMigrateEngine(source, args);
  inFlightMigrations.add(run);
  // Swallow nothing: the caller still awaits `run`'s real outcome. The
  // deregistration promise is deliberately separate so a rejection here
  // can't turn into an unhandled rejection when the caller already handled it.
  void run.then(() => { inFlightMigrations.delete(run); }, () => { inFlightMigrations.delete(run); });
  return run;
}

/** Await every registered run to settle. Safe to call when the set is empty. */
async function drainInFlightMigrations(): Promise<void> {
  while (inFlightMigrations.size > 0) {
    await Promise.allSettled([...inFlightMigrations]);
  }
}

/**
 * Each `runMigrateEngine` test below stands up two or three PGLite engines and
 * runs two complete migrations; every engine instance replays 121 schema
 * migrations first. On a loaded developer box the three tests measured 31.7s /
 * 46.2s / 61.9s — all three blew the previous 30s budget, and the slowest had
 * not finished at 61.9s, so the repo's usual 60s ceiling is short too.
 *
 * Do NOT read a timeout here as evidence of a cross-test env race. bun does not
 * overlap anything: a per-test timeout does not abandon the promise, it awaits
 * it to settle and reports the true elapsed time. The tell is arithmetic — this
 * file's 31.7 + 46.2 + 61.9 sums to 139.8s against a reported total of 145.85s,
 * so nothing ran concurrently and no test's `finally` can fire during another
 * test's migration.
 *
 * Runtime is dominated by whatever else the machine is doing — the same test has
 * both passed under a 180s budget and overrun a 300s one — so treat this number
 * as headroom, not a guarantee.
 *
 * Raising it is not papering over a fixable cost. The schema work HAS been
 * shared away via the snapshot above (~2x); what remains is irreducible PGLite
 * WASM cluster boot. The first test alone needs FIVE clusters: the in-memory
 * source, the migration target, a verify engine, the target again for the
 * resume run, and a second verify engine. None can be pooled — PGLite takes an
 * exclusive lock on a data dir, so the verify engines must disconnect before
 * the resume migrate reopens the target — and none can be dropped without
 * giving up the actual #3194 assertion that a failed page did not silently
 * vanish from the target. At ~15-20s per boot under load, five boots do not fit
 * in 60s: an instrumented run of the first test came in at 62422ms WITH the
 * snapshot active.
 */
const MIGRATION_TEST_TIMEOUT_MS = 300_000;

function fakePage(overrides: Partial<Page> = {}): Page {
  return {
    id: 1,
    slug: 'test-page',
    type: 'note',
    title: 'a title',
    compiled_truth: 'body',
    timeline: '',
    frontmatter: {},
    source_id: 'default',
    revision: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('copyPageToTarget — undefined-column normalization (#3194)', () => {
  test('undefined page fields become explicit null before reaching target.putPage', async () => {
    const putPageCalls: unknown[] = [];
    const target = {
      putPage: async (slug: string, page: unknown, opts: unknown) => {
        putPageCalls.push({ slug, page, opts });
        return fakePage();
      },
    } as unknown as BrainEngine;
    const source = {
      getChunksWithEmbeddings: async () => [],
      getTags: async () => [],
      getTimeline: async () => [],
      getRawData: async () => [],
    } as unknown as BrainEngine;

    // Simulate the exact PGLite read-side shape from #3194: a page whose
    // `type` / `compiled_truth` / `content_hash` came back `undefined`
    // (legitimately NULL/absent on the source) rather than an empty string
    // or explicit `null`.
    const page = fakePage({
      type: undefined as unknown as string,
      compiled_truth: undefined as unknown as string,
      content_hash: undefined,
    });

    await copyPageToTarget(source, target, page);

    expect(putPageCalls.length).toBe(1);
    const call = putPageCalls[0] as { slug: string; page: Record<string, unknown>; opts: unknown };
    expect(call.slug).toBe('test-page');
    // The driver-shape `undefined` must have become an explicit SQL NULL...
    expect(call.page.type).toBeNull();
    expect(call.page.compiled_truth).toBeNull();
    expect(call.page.content_hash).toBeNull();
    // ...while legitimately-populated fields pass through untouched.
    expect(call.page.title).toBe('a title');
    expect(call.opts).toEqual({ sourceId: 'default' });
  });

  test('already-null / already-populated fields are left as-is (no double-mapping)', async () => {
    const putPageCalls: unknown[] = [];
    const target = {
      putPage: async (slug: string, page: unknown, opts: unknown) => {
        putPageCalls.push({ slug, page, opts });
        return fakePage();
      },
    } as unknown as BrainEngine;
    const source = {
      getChunksWithEmbeddings: async () => [],
      getTags: async () => [],
      getTimeline: async () => [],
      getRawData: async () => [],
    } as unknown as BrainEngine;

    const page = fakePage({ content_hash: 'abc123' });
    await copyPageToTarget(source, target, page);

    const call = putPageCalls[0] as { page: Record<string, unknown> };
    expect(call.page.content_hash).toBe('abc123');
    expect(call.page.type).toBe('note');
  });
});

describe('runMigrateEngine — per-page failures are surfaced, not swallowed (#3194)', () => {
  // A clean `runMigrateEngine` ends in `saveConfig(newConfig)`, and `configDir()`
  // resolves GBRAIN_HOME at CALL time — so a caller that forgets it silently
  // rewrites the machine-global ~/.gbrain/config.json. Each test below already
  // sandboxes itself correctly, setting GBRAIN_HOME and restoring it in a
  // `finally`, and this file is NOT the source of the repeatedly-observed clobber
  // of that global config: a negative control ran it under a fake home with all
  // three migrate tests timing out and left paired temp dirs with the sentinel
  // config untouched. The artifact settles it independently — the clobbered file
  // carried the user's real keys (self_upgrade, embedding_model, schema_pack),
  // which can only come from `...existingFile` reading the REAL config, whereas
  // this file's guard-only `saveConfig` would have left a 2-key object first.
  //
  // The file-scoped pin below is therefore cheap defence in depth, not a fix for
  // that bug. It makes `prevGbrainHome` DEFINED for every test in the file, so no
  // per-test restore can leave GBRAIN_HOME unset for whatever runs next in this
  // process, and any write that escapes a test lands inside the sandbox. The real
  // containment is the fail-closed guard in `saveConfig` itself.
  let fileSandbox: string;
  let prevFileGbrainHome: string | undefined;

  beforeAll(() => {
    prevFileGbrainHome = process.env.GBRAIN_HOME;
    fileSandbox = mkdtempSync(join(tmpdir(), 'gbrain-migrate-filesandbox-'));
    process.env.GBRAIN_HOME = fileSandbox;
    // The sandbox must hold a READABLE config, not just exist. Anything that
    // resolves `configDir()` here while no per-test home is active — an
    // overrunning test's trailing work, or the window before a test's own
    // `saveConfig` lands — calls `loadConfig()`, and an empty gbrain home makes
    // that abort the whole process with "No brain configured. Run: gbrain init",
    // taking the rest of the file's tests down with it. Same inert guard-only
    // shape each test writes into its own home.
    saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });
  });

  afterAll(() => {
    if (prevFileGbrainHome !== undefined) process.env.GBRAIN_HOME = prevFileGbrainHome;
    else delete process.env.GBRAIN_HOME;
    rmSync(fileSandbox, { recursive: true, force: true });
  });

  // Backstop for the abort case: when bun cancels a test at its timeout, the
  // test body's own `finally` may never run, so the drain has to exist here
  // too. This hook is what guarantees the NEXT test cannot start (and the
  // file cannot end) with a previous migration still running against a
  // GBRAIN_HOME that is about to be deleted.
  afterEach(async () => {
    await drainInFlightMigrations();
    _resetCliExitVerdictForTests();
  });

  test('a page whose target write throws is excluded from the resume manifest and flips the exit verdict', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-')), 'brain.pglite');
    const prevGbrainHome = process.env.GBRAIN_HOME;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const prevExitCode = process.exitCode;

    let source: PGLiteEngine | null = null;
    let verifyEngine: PGLiteEngine | null = null;
    const originalPutPage = PGLiteEngine.prototype.putPage;

    try {
      // #427-style hermeticity: no live DATABASE_URL must leak into the
      // config engine-inference logic (would force engine='postgres' with
      // database_path cleared, unrelated to what we're testing here).
      delete process.env.DATABASE_URL;
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.GBRAIN_HOME = gbrainHome;

      // `runMigrateEngine`'s only use of the on-disk config is the
      // "already using this engine" guard + preserving unrelated file-plane
      // settings; it never reconnects using it (the caller-supplied
      // `sourceEngine` instance is used directly). engine='postgres' here
      // just satisfies "config.engine !== --to pglite" so the guard passes.
      saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      await source.putPage('good-page', {
        type: 'note', title: 'Good', compiled_truth: 'good body', timeline: '', frontmatter: {},
      });
      await source.putPage('bad-page', {
        type: 'note', title: 'Bad', compiled_truth: 'bad body', timeline: '', frontmatter: {},
      });

      // Fault injection: the target's putPage throws for exactly one slug,
      // simulating the real #3194 failure mode (a per-page write that
      // can't land on the target) without needing a live Postgres target.
      PGLiteEngine.prototype.putPage = async function (
        this: PGLiteEngine,
        slug: string,
        page: Parameters<typeof originalPutPage>[1],
        opts?: Parameters<typeof originalPutPage>[2],
      ) {
        if (slug === 'bad-page') {
          throw new Error('simulated unrecoverable write failure for bad-page');
        }
        return originalPutPage.call(this, slug, page, opts);
      };

      await trackedMigrate(source, ['--to', 'pglite', '--path', targetDbPath]);

      // 1. Exit verdict must reflect the partial failure.
      expect(currentExitCode()).toBe(1);

      // 2. The resume manifest must exist (not cleared) and must exclude
      //    the failed page while including the successful one.
      const manifestPath = join(gbrainHome, '.gbrain', 'migrate-manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { completed_slugs: string[] };
      expect(manifest.completed_slugs).toContain('good-page');
      expect(manifest.completed_slugs).not.toContain('bad-page');

      // 3. The target actually has the good page and does NOT have the bad
      //    one — i.e. the bad page did not silently vanish while counted
      //    as copied.
      verifyEngine = new PGLiteEngine();
      await verifyEngine.connect({ database_path: targetDbPath });
      expect(await verifyEngine.getPage('good-page')).not.toBeNull();
      expect(await verifyEngine.getPage('bad-page')).toBeNull();
      await verifyEngine.disconnect();
      verifyEngine = null;

      // 4. A partial run must NOT flip the active config onto the
      //    incomplete target — otherwise every subsequent `gbrain`
      //    invocation would silently start using a brain missing pages,
      //    AND the natural retry below would hit the "already using X"
      //    guard instead of actually resuming.
      expect(loadConfigFileOnly()?.engine).toBe('postgres');

      // 5. Resume: fix the fault, re-run the SAME command with no --force.
      //    This must not hit the "target brain is not empty" guard (the
      //    target already has `good-page` from the run above) and must
      //    NOT re-wipe/lose `good-page` — only the previously-failed page
      //    should be (re-)written.
      _resetCliExitVerdictForTests();
      PGLiteEngine.prototype.putPage = originalPutPage;
      await trackedMigrate(source, ['--to', 'pglite', '--path', targetDbPath]);

      expect(currentExitCode()).toBe(0);
      expect(existsSync(manifestPath)).toBe(false); // clean run clears the manifest
      expect(loadConfigFileOnly()?.engine).toBe('pglite'); // now safe to switch

      verifyEngine = new PGLiteEngine();
      await verifyEngine.connect({ database_path: targetDbPath });
      expect(await verifyEngine.getPage('good-page')).not.toBeNull();
      expect(await verifyEngine.getPage('bad-page')).not.toBeNull();
    } finally {
      // MUST precede the GBRAIN_HOME restore below: a still-running migration
      // would otherwise reach saveConfig() with the env already torn down.
      await drainInFlightMigrations();
      PGLiteEngine.prototype.putPage = originalPutPage;
      if (source) await source.disconnect();
      if (verifyEngine) await verifyEngine.disconnect();
      _resetCliExitVerdictForTests();
      process.exitCode = prevExitCode;
      if (prevGbrainHome !== undefined) process.env.GBRAIN_HOME = prevGbrainHome; else delete process.env.GBRAIN_HOME;
      if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prevGbrainDatabaseUrl;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
    }
  }, MIGRATION_TEST_TIMEOUT_MS);

  test('a run where every page fails AFTER putPage lands still writes a manifest — no --force needed to resume', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-')), 'brain.pglite');
    const prevGbrainHome = process.env.GBRAIN_HOME;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const prevExitCode = process.exitCode;

    let source: PGLiteEngine | null = null;
    let verifyEngine: PGLiteEngine | null = null;
    const originalGetRawData = PGLiteEngine.prototype.getRawData;

    try {
      delete process.env.DATABASE_URL;
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.GBRAIN_HOME = gbrainHome;
      saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      await source.putPage('only-page', {
        type: 'note', title: 'Only', compiled_truth: 'only body', timeline: '', frontmatter: {},
      });

      // Fault injection: the SOURCE's getRawData throws — this runs AFTER
      // putPage has already landed the row on the target, so the page's
      // copy fails mid-way rather than before anything was written.
      // completed_slugs therefore never gets an entry for it.
      PGLiteEngine.prototype.getRawData = async function (
        this: PGLiteEngine,
        slug: string,
        rdSource?: string,
        opts?: { sourceId?: string },
      ) {
        if (slug === 'only-page') throw new Error('simulated post-putPage failure');
        return originalGetRawData.call(this, slug, rdSource, opts);
      };

      await trackedMigrate(source, ['--to', 'pglite', '--path', targetDbPath]);
      expect(currentExitCode()).toBe(1);

      // The target actually has the row (putPage succeeded) even though
      // the whole page-copy was counted as failed.
      verifyEngine = new PGLiteEngine();
      await verifyEngine.connect({ database_path: targetDbPath });
      expect(await verifyEngine.getPage('only-page')).not.toBeNull();
      await verifyEngine.disconnect();
      verifyEngine = null;

      // The manifest file must exist on disk (with an empty completed_slugs)
      // even though not a single page fully succeeded — otherwise the next
      // invocation can't tell this was a resumable in-progress migration
      // and would hit the non-empty guard demanding --force.
      const manifestPath = join(gbrainHome, '.gbrain', 'migrate-manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { completed_slugs: string[] };
      expect(manifest.completed_slugs).toEqual([]);

      // Retry with no --force: must resume cleanly (not hit the "target
      // brain is not empty" abort) since a matching manifest is present.
      _resetCliExitVerdictForTests();
      PGLiteEngine.prototype.getRawData = originalGetRawData;
      await trackedMigrate(source, ['--to', 'pglite', '--path', targetDbPath]);
      expect(currentExitCode()).toBe(0);
      expect(existsSync(manifestPath)).toBe(false);
    } finally {
      // MUST precede the GBRAIN_HOME restore below — see the first test.
      await drainInFlightMigrations();
      PGLiteEngine.prototype.getRawData = originalGetRawData;
      if (source) await source.disconnect();
      if (verifyEngine) await verifyEngine.disconnect();
      _resetCliExitVerdictForTests();
      process.exitCode = prevExitCode;
      if (prevGbrainHome !== undefined) process.env.GBRAIN_HOME = prevGbrainHome; else delete process.env.GBRAIN_HOME;
      if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prevGbrainDatabaseUrl;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
    }
  }, MIGRATION_TEST_TIMEOUT_MS);

  test('--force always resets the manifest, even when the target looks empty (stale manifest from a recreated target)', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-'));
    const targetDbPath = join(targetDir, 'brain.pglite');
    const prevGbrainHome = process.env.GBRAIN_HOME;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const prevExitCode = process.exitCode;

    let source: PGLiteEngine | null = null;
    let verifyEngine: PGLiteEngine | null = null;

    try {
      delete process.env.DATABASE_URL;
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.GBRAIN_HOME = gbrainHome;
      saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      await source.putPage('real-page', {
        type: 'note', title: 'Real', compiled_truth: 'real body', timeline: '', frontmatter: {},
      });

      // Simulate a stale manifest surviving a target that was recreated
      // out-of-band (e.g. the operator deleted/rebuilt the target DB file
      // but ~/.gbrain/migrate-manifest.json was left behind): a manifest
      // matching this exact target_id claims `real-page` is already done,
      // even though the target directory is otherwise fresh/empty.
      const { migrationTargetId } = await import('../src/commands/migrate-engine.ts');
      const targetId = migrationTargetId({ engine: 'pglite', database_path: targetDbPath });
      const manifestPath = join(gbrainHome, '.gbrain', 'migrate-manifest.json');
      const fakeStaleManifest = {
        completed_slugs: ['real-page'],
        target_engine: 'pglite',
        target_id: targetId,
        schema_version: 2,
        started_at: new Date().toISOString(),
      };
      const { mkdirSync, writeFileSync } = await import('fs');
      mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify(fakeStaleManifest, null, 2));

      // --force on an empty target must NOT trust that stale manifest —
      // `real-page` must actually get copied, not skipped as "already done".
      await trackedMigrate(source, ['--to', 'pglite', '--path', targetDbPath, '--force']);
      expect(currentExitCode()).toBe(0);

      verifyEngine = new PGLiteEngine();
      await verifyEngine.connect({ database_path: targetDbPath });
      expect(await verifyEngine.getPage('real-page')).not.toBeNull();
    } finally {
      // MUST precede the GBRAIN_HOME restore below — see the first test.
      await drainInFlightMigrations();
      if (source) await source.disconnect();
      if (verifyEngine) await verifyEngine.disconnect();
      _resetCliExitVerdictForTests();
      process.exitCode = prevExitCode;
      if (prevGbrainHome !== undefined) process.env.GBRAIN_HOME = prevGbrainHome; else delete process.env.GBRAIN_HOME;
      if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prevGbrainDatabaseUrl;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  }, MIGRATION_TEST_TIMEOUT_MS);
});
