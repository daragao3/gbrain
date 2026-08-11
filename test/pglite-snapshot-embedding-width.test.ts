/**
 * Regression guard for the Tier 3 snapshot / test-gateway width mismatch.
 *
 * `scripts/build-pglite-snapshot.ts` bakes an `embedding vector(N)` column into
 * the fixture. `bunfig.toml`'s `[test] preload` decides what N the suite writes.
 * The builder runs under `bun run`, which does NOT apply that preload, so the
 * two silently disagreed: the fixture was baked at the production default
 * (1280) while every test ran at 1536. Because a snapshot-loaded engine skips
 * `initSchema()` entirely, the column stayed 1280 and every embedding-writing
 * test failed with `expected 1280 dimensions, not 1536` — but only in the shards
 * where no sibling file had already forced a cold init, so which files broke
 * depended on shard bin-packing.
 *
 * Two invariants keep that from coming back.
 */
import { describe, test, expect } from 'bun:test';
import * as crypto from 'node:crypto';

import { computeSnapshotSchemaHash } from '../src/core/pglite-engine.ts';
import { getEmbeddingDimensions } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

const MIGRATIONS_FIXTURE = [
  { version: 1, name: 'first', sql: 'SELECT 1' },
  { version: 2, name: 'second', sqlFor: { pglite: 'SELECT 2' } },
];
const SCHEMA_FIXTURE = 'CREATE TABLE pages (embedding vector(__EMBEDDING_DIMS__));';

describe('snapshot hash folds the embedding width', () => {
  test('same width hashes identically', () => {
    const a = computeSnapshotSchemaHash(MIGRATIONS_FIXTURE, SCHEMA_FIXTURE, crypto, 1536);
    const b = computeSnapshotSchemaHash(MIGRATIONS_FIXTURE, SCHEMA_FIXTURE, crypto, 1536);
    expect(a).toBe(b);
  });

  test('a different width yields a different hash', () => {
    // The schema TEXT is byte-identical at both widths — it carries the
    // `__EMBEDDING_DIMS__` placeholder, which is exactly why hashing the
    // template alone could not catch this. The width must be hashed separately.
    const at1536 = computeSnapshotSchemaHash(MIGRATIONS_FIXTURE, SCHEMA_FIXTURE, crypto, 1536);
    const at1280 = computeSnapshotSchemaHash(MIGRATIONS_FIXTURE, SCHEMA_FIXTURE, crypto, 1280);
    expect(at1536).not.toBe(at1280);
  });

  test('the width is not merely concatenated into the migration digest', () => {
    // Guards against a fold so weak that a 1-vs-15 / 36-vs-3 style boundary
    // shift produces a collision.
    const a = computeSnapshotSchemaHash(MIGRATIONS_FIXTURE, SCHEMA_FIXTURE, crypto, 1);
    const b = computeSnapshotSchemaHash(MIGRATIONS_FIXTURE, SCHEMA_FIXTURE, crypto, 15);
    expect(a).not.toBe(b);
  });
});

describe('the running suite matches the width the fixture is baked at', () => {
  test('gateway width equals LEGACY_EMBEDDING_CONFIG', () => {
    // The preload (bunfig `[test] preload`) and the fixture builder now read
    // ONE constant. If someone re-hardcodes either side, this fails here rather
    // than as a dimension error in whichever unrelated file the shard packer
    // happened to schedule after a snapshot-loading neighbour.
    expect(getEmbeddingDimensions()).toBe(LEGACY_EMBEDDING_CONFIG.embedding_dimensions);
  });
});
