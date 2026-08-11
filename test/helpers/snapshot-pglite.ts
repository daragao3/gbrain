/**
 * File-scoped Tier 3 opt-IN: let this file's PGLite engines restore the
 * pre-migrated snapshot fixture instead of replaying the whole migration
 * ladder, without disturbing any other file in the process.
 *
 * This is the mirror image of `useColdPglite()` in `./cold-pglite.ts`, and it
 * exists for the same reason: `process.env` is process-global, and bun's
 * runner loads and runs test files sequentially in ONE process per shard (on
 * POSIX CI that is a ~270-file process). A bare module-level
 * `process.env.GBRAIN_PGLITE_SNAPSHOT = ...` therefore leaks into every file
 * listed AFTER it, and which files get hit depends entirely on shard
 * bin-packing — adding any test file reshuffles it. `beforeAll`/`afterAll`
 * bracket the file instead.
 *
 * `GBRAIN_PGLITE_SNAPSHOT_SEED_FILE` is the more dangerous of the two to leak:
 * it lets a FILE-BACKED dataDir be seeded from the fixture, which changes what
 * a fresh on-disk brain looks like at connect() time. Leaking that into a file
 * that asserts on fresh-install state would be a silent behaviour change, not
 * just a speed change.
 *
 * Register it at the TOP of the file, above any `beforeAll` that connects an
 * engine — bun runs top-level hooks in registration order, so the env has to
 * be in place before the first engine is created.
 *
 *   import { useSnapshotPglite } from './helpers/snapshot-pglite.ts';
 *
 *   useSnapshotPglite();
 *
 * `seedFileBacked` defaults to false. Pass true only when the file creates a
 * fresh file-backed brain whose SCHEMA is incidental to the assertions (a
 * migration target, say) rather than the thing under test.
 *
 * The fixture is gitignored and built on demand (`bun run build:pglite-snapshot`),
 * so it is legitimately absent on a fresh clone. Absent — or hash-stale — means
 * `tryLoadSnapshot` returns null and the engine falls back to a normal cold
 * init: slower, but still correct. Nothing here asserts the fixture exists.
 */
import { beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_FILE_ENV } from '../../src/core/pglite-snapshot.ts';

const SNAPSHOT_ENV = 'GBRAIN_PGLITE_SNAPSHOT';

/** `test/fixtures/pglite-snapshot.tar`, resolved off THIS file, not cwd. */
export function defaultFixturePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pglite-snapshot.tar');
}

export function useSnapshotPglite(opts: { seedFileBacked?: boolean } = {}): void {
  const fixture = defaultFixturePath();
  let priorSnapshot: string | undefined;
  let priorSeed: string | undefined;
  let saved = false;

  beforeAll(() => {
    priorSnapshot = process.env[SNAPSHOT_ENV];
    priorSeed = process.env[SEED_FILE_ENV];
    saved = true;
    // Respect an ambient value (scripts/ci-local.sh exports one for the whole
    // suite); only point at the local fixture when nothing else has.
    if (!process.env[SNAPSHOT_ENV] && existsSync(fixture)) {
      process.env[SNAPSHOT_ENV] = fixture;
    }
    if (opts.seedFileBacked && process.env[SNAPSHOT_ENV]) {
      process.env[SEED_FILE_ENV] = '1';
    }
  });

  afterAll(() => {
    // Guard on `saved` rather than `prior !== undefined`: if beforeAll never
    // ran we must not touch either variable, and "was unset" is a real state
    // we have to be able to restore to.
    if (!saved) return;
    if (priorSnapshot === undefined) delete process.env[SNAPSHOT_ENV];
    else process.env[SNAPSHOT_ENV] = priorSnapshot;
    if (priorSeed === undefined) delete process.env[SEED_FILE_ENV];
    else process.env[SEED_FILE_ENV] = priorSeed;
  });
}
