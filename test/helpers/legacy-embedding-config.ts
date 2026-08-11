/**
 * The ONE definition of the embedding shape the unit suite runs at.
 *
 * Two consumers must agree on this or the Tier 3 PGLite snapshot silently
 * breaks every embedding-writing test:
 *
 *   1. `test/helpers/legacy-embedding-preload.ts` — bunfig's `[test] preload`,
 *      which pins the gateway before any test runs.
 *   2. `scripts/build-pglite-snapshot.ts` — the fixture builder, which bakes an
 *      `embedding vector(N)` column into the tar.
 *
 * They used to disagree. The builder runs under `bun run`, which does NOT apply
 * bunfig's `[test] preload`, so it baked the production default (zembed-1 @
 * 1280) while the suite ran at OpenAI/1536. A snapshot-loaded engine skips
 * `initSchema()` entirely, so the column stayed 1280 and every test that wrote a
 * 1536-d vector died with `expected 1280 dimensions, not 1536`. Nothing caught
 * it: the snapshot's staleness hash covered the schema TEMPLATE (which carries a
 * `__EMBEDDING_DIMS__` placeholder, identical at either width) but not the width
 * substituted into it.
 *
 * This module has no `bun:test` import ON PURPOSE — the builder is a plain
 * script and cannot import a module that registers test hooks.
 *
 * Changing the width here is enough; the snapshot hash folds it in
 * (`computeSnapshotSchemaHash`), so a fixture built at the old width stops
 * matching and falls back to a normal cold init instead of failing loudly.
 */
export const LEGACY_EMBEDDING_CONFIG = {
  embedding_model: 'openai:text-embedding-3-large',
  embedding_dimensions: 1536,
} as const;
