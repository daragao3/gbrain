/**
 * The seeded path and the cold-init path must produce the SAME schema.
 *
 * Serial + slow: each arm boots a WASM Postgres against a fresh dataDir. On
 * Windows under load that is ~30-110s per arm, hence the generous budget.
 * Skips unless the snapshot fixture exists — build it with:
 *
 *     bun run build:pglite-snapshot
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { repoPath } from './helpers/repo-root.ts';

const SNAPSHOT = repoPath('test', 'fixtures', 'pglite-snapshot.tar');
const HAVE_FIXTURE =
  existsSync(SNAPSHOT) && existsSync(SNAPSHOT.replace(/\.tar$/, '.version'));

const dirs: string[] = [];
function freshDataDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'gbrain-seed-'));
  dirs.push(base);
  return join(base, 'brain.pglite');
}

afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Highest applied migration version, the schema's observable head. */
async function migrationHead(engine: PGLiteEngine): Promise<number> {
  return Number.parseInt((await engine.getConfig('version')) ?? '-1', 10);
}

type EnvPatch = Record<string, string | undefined>;

/** Apply an env patch for the duration of `fn`, restoring exactly on exit. */
async function withEnv<T>(patch: EnvPatch, fn: () => Promise<T>): Promise<T> {
  const prev: EnvPatch = {};
  for (const k of Object.keys(patch)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Boot a brain at `dataDir` under `patch`, return its migration head. */
async function headUnder(dataDir: string, patch: EnvPatch): Promise<number> {
  return withEnv(patch, async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();
      return await migrationHead(engine);
    } finally {
      await engine.disconnect();
    }
  });
}

const SEEDED: EnvPatch = {
  GBRAIN_PGLITE_SNAPSHOT: SNAPSHOT,
  GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '1',
};
const COLD: EnvPatch = {
  GBRAIN_PGLITE_SNAPSHOT: undefined,
  GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: undefined,
};
/** Base var set, seed flag absent — the ci:local blast-radius guard. */
const BASE_ONLY: EnvPatch = {
  GBRAIN_PGLITE_SNAPSHOT: SNAPSHOT,
  GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: undefined,
};

describe.if(HAVE_FIXTURE)('file-backed snapshot seeding', () => {
  test('seeded dataDir reaches the same migration head as cold init and reopens', async () => {
    const seededDataDir = freshDataDir();
    const seeded = await headUnder(seededDataDir, SEEDED);
    const reopened = await headUnder(seededDataDir, SEEDED);
    const cold = await headUnder(freshDataDir(), COLD);
    expect(seeded).toBeGreaterThan(0);
    expect(reopened).toBe(seeded);
    expect(seeded).toBe(cold);
  }, 900_000);

  test('seeding is skipped when the opt-in flag is absent', async () => {
    expect(await headUnder(freshDataDir(), BASE_ONLY)).toBeGreaterThan(0);
  }, 900_000);
});
