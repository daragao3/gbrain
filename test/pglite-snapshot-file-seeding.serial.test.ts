/**
 * The seeded path and the cold-init path must produce the SAME schema.
 *
 * Serial + slow: each arm boots a WASM Postgres against a fresh dataDir. On
 * Windows under load that is ~30-110s per arm, hence the generous budget.
 * The serial runner builds the gitignored snapshot fixture automatically. For
 * direct invocation, build it first with `bun run build:pglite-snapshot`.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as crypto from 'node:crypto';
import {
  PGLiteEngine,
  computeSnapshotSchemaHash,
} from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { repoPath } from './helpers/repo-root.ts';

const SNAPSHOT = repoPath('test', 'fixtures', 'pglite-snapshot.tar');
const SNAPSHOT_VERSION = SNAPSHOT.replace(/\.tar$/, '.version');
if (!existsSync(SNAPSHOT) || !existsSync(SNAPSHOT_VERSION)) {
  throw new Error('snapshot fixture missing; run bun run build:pglite-snapshot before this test');
}
// Same width the fixture was baked at (see scripts/build-pglite-snapshot.ts);
// hashing at any other width reports a fresh fixture as stale.
const expectedSnapshotVersion = computeSnapshotSchemaHash(
  MIGRATIONS,
  PGLITE_SCHEMA_SQL,
  crypto,
  LEGACY_EMBEDDING_CONFIG.embedding_dimensions,
);
const actualSnapshotVersion = readFileSync(SNAPSHOT_VERSION, 'utf8').trim();
if (actualSnapshotVersion !== expectedSnapshotVersion) {
  throw new Error('snapshot fixture stale; run bun run build:pglite-snapshot before this test');
}

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
/** Base var set, seed flag absent — the ci:local blast-radius guard. */
const BASE_ONLY: EnvPatch = {
  GBRAIN_PGLITE_SNAPSHOT: SNAPSHOT,
  GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: undefined,
};

describe('file-backed snapshot seeding', () => {
  test('seeded and cold-init fresh dataDirs reach the same canonical head', async () => {
    const seededDataDir = freshDataDir();
    const seeded = await withEnv(SEEDED, async () => {
      const engine = new PGLiteEngine();
      try {
        await engine.connect({ database_path: seededDataDir });
        return await migrationHead(engine);
      } finally {
        await engine.disconnect();
      }
    });
    const canonicalHead = Math.max(...MIGRATIONS.map((migration) => migration.version));
    expect(seeded).toBe(canonicalHead);
    expect(await headUnder(seededDataDir, SEEDED)).toBe(canonicalHead);

    const cold = await withEnv(BASE_ONLY, async () => {
      const engine = new PGLiteEngine();
      try {
        await engine.connect({ database_path: freshDataDir() });
        await expect(engine.getConfig('version')).rejects.toThrow(/config|relation/i);
        await engine.initSchema();
        return await migrationHead(engine);
      } finally {
        await engine.disconnect();
      }
    });
    expect(cold).toBe(seeded);
  }, 900_000);
});
