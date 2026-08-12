#!/usr/bin/env bun
// scripts/build-pglite-snapshot.ts
//
// Tier 3 fast-restore: boot a fresh PGLite, run the full initSchema (forward
// bootstrap + PGLITE_SCHEMA_SQL + every migration), dump the post-init state
// to a tar fixture. Test files that read GBRAIN_PGLITE_SNAPSHOT can skip the
// 1-3 seconds of cold init and load the post-schema state directly.
//
// Output: test/fixtures/pglite-snapshot.tar (binary, gitignored)
//         test/fixtures/pglite-snapshot.version (hex SHA256 of MIGRATIONS SQL)
//
// The version file lets the engine detect snapshot staleness — if the tar's
// recorded version doesn't match the current MIGRATIONS hash, the engine
// ignores the snapshot and runs a normal initSchema.
//
// Run: bun run scripts/build-pglite-snapshot.ts
//      (or: bun run build:pglite-snapshot)
//
//      bun run scripts/build-pglite-snapshot.ts --if-stale
//        Build only when the fixture is missing OR its recorded hash no longer
//        matches the current schema/migrations/embedding width. A fixture that
//        is already current is left alone and the ~15-95s boot is skipped.
//        This is what scripts/ci-local.sh calls: an "exists?" check alone
//        cannot see a fixture built before a schema change, and
//        test/pglite-snapshot-file-seeding.serial.test.ts THROWS on a stale
//        fixture at module scope rather than degrading to a cold init the way
//        the engine does.
//
// Re-run whenever you touch src/core/migrate.ts or src/schema.sql.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import * as crypto from "node:crypto";

import { PGLiteEngine, computeSnapshotSchemaHash } from "../src/core/pglite-engine.ts";
import { MIGRATIONS } from "../src/core/migrate.ts";
import { PGLITE_SCHEMA_SQL } from "../src/core/pglite-schema.ts";
import { configureGateway } from "../src/core/ai/gateway.ts";
import { LEGACY_EMBEDDING_CONFIG } from "../test/helpers/legacy-embedding-config.ts";

function computeSchemaHash(): string {
  return computeSnapshotSchemaHash(
    MIGRATIONS,
    PGLITE_SCHEMA_SQL,
    crypto,
    LEGACY_EMBEDDING_CONFIG.embedding_dimensions,
  );
}

/**
 * Why the fixture on disk cannot be reused, or null when it can be.
 *
 * The reason is returned rather than a bare boolean so the caller can say WHICH
 * of "absent" and "stale" it hit — a rerunning CI job that keeps rebuilding is
 * a different problem from one that never had the fixture at all.
 */
function staleReason(fixturePath: string, versionPath: string, schemaHash: string): string | null {
  if (!existsSync(fixturePath)) return `${fixturePath} is missing`;
  if (!existsSync(versionPath)) return `${versionPath} is missing`;
  let recorded: string;
  try {
    recorded = readFileSync(versionPath, "utf8").trim();
  } catch (err) {
    return `${versionPath} is unreadable (${(err as Error).message})`;
  }
  if (recorded !== schemaHash) {
    return `schema hash changed (fixture ${recorded.slice(0, 16) || "<empty>"}..., expected ${schemaHash.slice(0, 16)}...)`;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const ifStale = args.includes("--if-stale");
  const unknown = args.filter((a) => a !== "--if-stale");
  if (unknown.length > 0) {
    console.error(`[build-pglite-snapshot] unknown argument(s): ${unknown.join(" ")}`);
    console.error(`[build-pglite-snapshot] usage: bun run scripts/build-pglite-snapshot.ts [--if-stale]`);
    process.exit(2);
  }

  const fixturePath = "test/fixtures/pglite-snapshot.tar";
  const versionPath = "test/fixtures/pglite-snapshot.version";
  mkdirSync(dirname(fixturePath), { recursive: true });

  const schemaHash = computeSchemaHash();

  if (ifStale) {
    const reason = staleReason(fixturePath, versionPath, schemaHash);
    if (reason === null) {
      console.log(
        `[build-pglite-snapshot] --if-stale: fixture is current ` +
        `(${schemaHash.slice(0, 16)}...) — skipping rebuild.`,
      );
      return;
    }
    console.log(`[build-pglite-snapshot] --if-stale: rebuilding — ${reason}.`);
  }

  console.log(`[build-pglite-snapshot] schema hash: ${schemaHash.slice(0, 16)}...`);
  console.log(`[build-pglite-snapshot] booting PGLite (in-memory)...`);
  const engine = new PGLiteEngine();

  // Bypass the env-aware short-circuit: we WANT a real init here.
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;

  // This script runs under `bun run`, which does NOT apply bunfig's
  // `[test] preload` — so the gateway is unconfigured here and initSchema would
  // fall back to the production default (zembed-1 @ 1280) while the suite runs
  // at OpenAI/1536. Pin the same config the preload pins, or the fixture bakes
  // an `embedding vector(1280)` column that rejects every test's 1536-d vector.
  configureGateway({
    ...LEGACY_EMBEDDING_CONFIG,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  console.log(
    `[build-pglite-snapshot] gateway pinned to ${LEGACY_EMBEDDING_CONFIG.embedding_model} ` +
    `@ ${LEGACY_EMBEDDING_CONFIG.embedding_dimensions}d (matches bunfig test preload)`,
  );

  await engine.connect({});
  console.log(`[build-pglite-snapshot] running initSchema (forward bootstrap + ${MIGRATIONS.length} migrations)...`);
  const t0 = Date.now();
  await engine.initSchema();
  console.log(`[build-pglite-snapshot] initSchema completed in ${Date.now() - t0}ms`);

  console.log(`[build-pglite-snapshot] dumping data dir...`);
  const dump = await engine.db.dumpDataDir("none");
  const buffer = Buffer.from(await dump.arrayBuffer());

  writeFileSync(fixturePath, buffer);
  writeFileSync(versionPath, schemaHash + "\n");
  await engine.disconnect();

  console.log(`[build-pglite-snapshot] wrote ${fixturePath} (${buffer.length} bytes)`);
  console.log(`[build-pglite-snapshot] wrote ${versionPath}`);
}

await main();
