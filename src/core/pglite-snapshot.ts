/**
 * Decision helpers for the `GBRAIN_PGLITE_SNAPSHOT` fast-restore.
 *
 * Kept out of `pglite-engine.ts` deliberately: these are pure, and importing
 * them must not drag in the PGLite WASM runtime. That is what lets the truth
 * table above run in milliseconds instead of booting a Postgres per case.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { findRepoRoot } from './repo-root.ts';

/** Opt-in for seeding a FILE-BACKED dataDir. Test-only; nothing in src/ sets it. */
export const SEED_FILE_ENV = 'GBRAIN_PGLITE_SNAPSHOT_SEED_FILE';

/**
 * May `connect()` pass a `loadDataDir` blob for this dataDir?
 *
 * - No dataDir (in-memory): always — long-standing behaviour, unchanged.
 * - File-backed: only behind `SEED_FILE_ENV === '1'` AND only when the dataDir
 *   holds no cluster yet. PGLite THROWS ("Database already exists, cannot load
 *   from tarball") rather than falling back if a `PG_VERSION` is already there.
 *
 * `env`/`fsExists` are injected so this is testable without global mutation.
 */
export function snapshotEligible(
  dataDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fsExists: (p: string) => boolean = existsSync,
): boolean {
  if (!dataDir) return true;
  if (env[SEED_FILE_ENV] !== '1') return false;
  // Verified against pglite 0.4.3: PG_VERSION sits at the dataDir root,
  // alongside base/, global/, pg_wal/, postgresql.conf.
  return !fsExists(join(dataDir, 'PG_VERSION'));
}

/**
 * Absolutize the snapshot path.
 *
 * The env var conventionally holds `test/fixtures/pglite-snapshot.tar`, which
 * only resolves when cwd is the repo root. Subprocess tests spawn from a
 * tmpdir, so a bare relative path silently misses and falls back to a slow
 * boot. Anchor to the repo root found from THIS module's location, which is
 * stable regardless of cwd.
 */
export function resolveSnapshotPath(
  raw: string,
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
  cwd: string = process.cwd(),
): string {
  if (isAbsolute(raw)) return raw;
  const root = findRepoRoot(moduleDir) ?? findRepoRoot(cwd);
  return root ? join(root, raw) : resolvePath(cwd, raw);
}
