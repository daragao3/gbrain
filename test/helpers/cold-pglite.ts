/**
 * File-scoped Tier 3 opt-out: force this file's PGLite engines through the real
 * cold init (forward bootstrap + schema + every migration) without disturbing
 * any other file in the process.
 *
 * Why this exists: the previous idiom was a bare module-level
 * `delete process.env.GBRAIN_PGLITE_SNAPSHOT`, and `process.env` is
 * process-global. Bun's runner loads and runs test files sequentially in ONE
 * process per shard (POSIX CI sets no chunk limit, so that is a ~270-file
 * process), so the delete leaked into every file listed AFTER the opt-out and
 * silently forced them all cold too. Measured: 3 of 4 unit shards got no
 * benefit from the snapshot at all, and which files were affected depended
 * entirely on shard bin-packing — adding any test file reshuffled it.
 *
 * `beforeAll`/`afterAll` bracket the file instead. Files that run before or
 * after this one keep whatever the runner gave them.
 *
 * Register it at the TOP of the file, above the file's own `beforeAll` that
 * connects the engine — bun runs top-level hooks in registration order, so the
 * env must be cleared before the engine is created:
 *
 *   import { useColdPglite } from './helpers/cold-pglite.ts';
 *
 *   useColdPglite();
 *
 *   beforeAll(async () => {
 *     engine = new PGLiteEngine();
 *     await engine.connect({});
 *     await engine.initSchema();
 *   });
 *
 * Only use this in files that genuinely assert on the cold path (bootstrap
 * behaviour, migration ledgers, fresh-install state). Every other PGLite file
 * should take the snapshot — that is the whole point of it.
 */
import { beforeAll, afterAll } from 'bun:test';

const SNAPSHOT_ENV = 'GBRAIN_PGLITE_SNAPSHOT';

export function useColdPglite(): void {
  let prior: string | undefined;
  let saved = false;

  beforeAll(() => {
    prior = process.env[SNAPSHOT_ENV];
    saved = true;
    delete process.env[SNAPSHOT_ENV];
  });

  afterAll(() => {
    // Guard on `saved` rather than `prior !== undefined`: if beforeAll never
    // ran we must not touch the variable at all, and "was unset" is a real
    // state we have to be able to restore to.
    if (!saved) return;
    if (prior === undefined) delete process.env[SNAPSHOT_ENV];
    else process.env[SNAPSHOT_ENV] = prior;
  });
}
