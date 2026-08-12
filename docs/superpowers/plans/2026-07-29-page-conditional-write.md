# Atomic Conditional Page Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add atomic create-only and revision compare-and-swap page writes while preserving the existing last-writer-wins `put_page` operation.

**Architecture:** Add a database-trigger-owned page revision plus source-qualified conditional primitives to `BrainEngine`, then let the existing import pipeline select legacy upsert or a conditional transaction without duplicating parsing, chunking, embedding, or projection reconciliation. Add a separate canonical `put_page_conditional` operation whose successful writes share the existing post-commit hooks and whose conflicts/unchanged results return before all successful-write hooks.

**Tech Stack:** Bun, TypeScript, postgres.js, PGLite, PostgreSQL triggers and transactions, MCP Streamable HTTP, `bun:test`.

## Global Constraints

- Preserve `put_page` parameters, last-writer-wins upsert behavior, and result compatibility.
- Add only the canonical `put_page_conditional` MCP operation; do not add an HTTP route or any stdio GBrain server/configuration.
- Page identity and every conditional predicate are `(source_id, slug)`; the authenticated operation context supplies `source_id` and payloads cannot override it.
- `create_only` rejects `expected_revision`; `compare_and_swap` requires a positive safe integer.
- Expected conflicts are normal typed results (`isError: false`) and never include page content.
- Soft-deleted rows remain conflicting tombstones; only `restore_page` restores them.
- Parsing, validation, hashing, chunking, and external embedding stay outside the transaction; the page statement, version snapshot, contextual retrieval state, tags, chunks, embedding signature, and in-transaction document/code links commit or roll back together.
- `conflict`, `unchanged`, and malformed-frontmatter results run no successful-write post-hooks.
- Keep Postgres and PGLite schemas and behavior aligned.
- `src/core/schema-embedded.ts` is generated from `src/schema.sql`; never edit it manually.
- Recheck the current migration head before assigning the new version; use v125 only if v124 is still latest.
- Keep commits `8d3c9989` and `caeb4321` as ancestors and do not branch from older `origin/master`.
- Do not downgrade or add dependencies, do not push, and do not alter the out-of-repo motivating client script identified in the private implementation handoff.
- Before each implementation edit, follow the repository's codegraph caller/blast protocol when the project MCP source is available; otherwise record the unavailable graph check and use exact source/reference searches.
- Use focused `bun test ...` commands during TDD on this Windows checkout; finish with repository verification, typecheck, and real-Postgres E2E.

---

## File Structure

**Create**

- `test/page-conditional-write.test.ts` — canonical one-engine-per-file PGLite behavioral suite for revision, conditional import transactions, side-effect-free conflicts, rollback, and source isolation.
- `test/put-page-conditional-operation.test.ts` — operation validation, typed-result, provenance, frontmatter, namespace, and post-hook gating tests.
- `test/e2e/page-conditional-write-concurrency.test.ts` — independent-connection real-Postgres create/CAS races, projection ownership, rollback, source, and tombstone checks.

**Modify**

- `src/core/types.ts` — add `Page.revision` and exported conditional result/precondition types.
- `src/core/engine.ts` — add source-qualified `createPageOnly`, `lockPageForConditionalWrite`, and `compareAndSwapPage` contracts.
- `src/core/utils.ts` — convert projected `BIGINT revision` to a safe JavaScript number.
- `src/core/postgres-engine.ts` — project revision, implement atomic insert/lock/guarded update, and extend forward-reference bootstrap.
- `src/core/pglite-engine.ts` — exact PGLite parity for projections, conditional methods, and bootstrap.
- `src/schema.sql` — fresh-schema revision column and trigger.
- `src/core/pglite-schema.ts` — fresh PGLite revision column and trigger.
- `src/core/migrate.ts` — idempotent revision migration and trigger installation.
- `src/core/schema-embedded.ts` — generated output only.
- `src/core/import-file.ts` — optional conditional precondition, deferred exact-key decision, conditional transaction, side-effect-free result propagation.
- `src/core/operations.ts` — shared put-page execution/post-hook helper and canonical `put_page_conditional` operation.
- `test/migrate.test.ts` — migration shape and live PGLite idempotency/trigger behavior.
- `test/bootstrap.test.ts` — upgraded-PGLite bootstrap regression.
- `test/schema-bootstrap-coverage.test.ts` — declare `pages.revision` as required bootstrap coverage.
- `test/pages-soft-delete.test.ts` — delete/restore revision increments.
- `test/pglite-engine.test.ts` — additive read revision and unchanged legacy upsert regression.
- `test/mcp-tool-defs.test.ts` — generated operation schema contract.
- `test/e2e/engine-parity.test.ts` — conditional result parity across engines.
- `test/e2e/postgres-bootstrap.test.ts` — upgraded-Postgres bootstrap and trigger regression.
- `test/e2e/http-transport.test.ts` — authenticated discovery, typed conflicts, CAS, source binding, and legacy compatibility.

No new transport or MCP configuration file is needed: `operations` remains the single operation registry for existing transports.

---

### Task 1: Revision Schema, Model, Migration, and Bootstrap

**Files:**
- Modify: `src/core/types.ts:85-178`
- Modify: `src/core/utils.ts:99-146`
- Modify: `src/schema.sql:90-195`
- Modify: `src/core/pglite-schema.ts` corresponding `pages` table and generation-trigger area
- Modify: `src/core/migrate.ts` after the current latest migration
- Modify: `src/core/postgres-engine.ts:479-945,1012-1129`
- Modify: `src/core/pglite-engine.ts:463-925,963-1070`
- Modify: `test/migrate.test.ts`
- Modify: `test/bootstrap.test.ts`
- Modify: `test/schema-bootstrap-coverage.test.ts:41-174`
- Modify: `test/e2e/postgres-bootstrap.test.ts`
- Modify: `test/pglite-engine.test.ts`
- Generated: `src/core/schema-embedded.ts`

**Interfaces:**
- Produces: `Page.revision: number` on every page read/write result.
- Produces: database column `pages.revision BIGINT NOT NULL DEFAULT 1`.
- Produces: `bump_page_revision_fn()` and `bump_page_revision_trg` on fresh and migrated Postgres/PGLite brains.
- Consumes: no conditional engine methods yet; existing `putPage`, `softDeletePage`, and `restorePage` prove that all writers participate through the trigger.

- [ ] **Step 1: Write failing migration, bootstrap, and projection tests**

Append a focused v125 block to `test/migrate.test.ts` (after rechecking that v124 is still latest):

```ts
describe('migrate v125 — page_revision_cas', () => {
  const migration = MIGRATIONS.find(m => m.version === 125);

  test('adds revision and installs an idempotent page-state trigger', () => {
    expect(migration?.name).toBe('page_revision_cas');
    expect(migration?.sql).toContain(
      'ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1',
    );
    expect(migration?.sql).toContain('CREATE OR REPLACE FUNCTION bump_page_revision_fn()');
    expect(migration?.sql).toContain('DROP TRIGGER IF EXISTS bump_page_revision_trg ON pages');
    expect(migration?.sql).toContain('CREATE TRIGGER bump_page_revision_trg');
    expect(migration?.sql).toContain('OLD.deleted_at IS DISTINCT FROM NEW.deleted_at');
    expect(migration?.sql).not.toContain('OLD.emotional_weight IS DISTINCT FROM NEW.emotional_weight');
    expect(migration?.sql).not.toContain('OLD.contextual_retrieval_mode IS DISTINCT FROM NEW.contextual_retrieval_mode');
  });
});
```

Add `pages.revision` to `REQUIRED_BOOTSTRAP_COVERAGE` in `test/schema-bootstrap-coverage.test.ts`:

```ts
{ kind: 'column', table: 'pages', column: 'revision' },
```

Extend that file's down-mutation SQL with:

```sql
DROP TRIGGER IF EXISTS bump_page_revision_trg ON pages;
DROP FUNCTION IF EXISTS bump_page_revision_fn;
ALTER TABLE pages DROP COLUMN IF EXISTS revision;
```

Add fresh/read regression tests to `test/pglite-engine.test.ts`:

```ts
test('putPage starts at revision 1 and getPage projects it as a number', async () => {
  const written = await engine.putPage('test/revision-read', testPage);
  expect(written.revision).toBe(1);
  const read = await engine.getPage('test/revision-read');
  expect(read?.revision).toBe(1);
  expect(typeof read?.revision).toBe('number');
});

test('legacy putPage still upserts and advances revision on page-state changes', async () => {
  const first = await engine.putPage('test/revision-upsert', testPage);
  const second = await engine.putPage('test/revision-upsert', {
    ...testPage,
    title: 'Updated Title',
  });
  expect(first.revision).toBe(1);
  expect(second.title).toBe('Updated Title');
  expect(second.revision).toBe(2);
});
```

Add a PGLite migration/trigger behavior test in `test/migrate.test.ts` that initializes one engine, calls `initSchema()` twice, updates a revision-changing field and a revision-neutral field, and expects revisions `1`, `2`, `2`.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
bun test test/migrate.test.ts test/schema-bootstrap-coverage.test.ts test/pglite-engine.test.ts
```

Expected: FAIL because migration v125, `pages.revision`, bootstrap coverage, and `Page.revision` do not exist.

- [ ] **Step 3: Add the model field and row conversion**

Add to `Page` in `src/core/types.ts`:

```ts
/** Page-local optimistic concurrency token. Starts at 1 and advances on client-observable page-state changes. */
revision: number;
```

In `rowToPage()` in `src/core/utils.ts`, add:

```ts
revision: Number(row.revision),
```

Update every `SELECT`/`RETURNING` that feeds `rowToPage()` in both engines to include `revision`. The required CRUD projections become:

```sql
SELECT id, source_id, slug, type, title, compiled_truth, timeline,
       frontmatter, content_hash, revision, created_at, updated_at, deleted_at,
       source_kind, source_uri, ingested_via, ingested_at
```

and the corresponding `RETURNING` list includes `revision`.

- [ ] **Step 4: Add the fresh-schema revision trigger to both schema baselines**

Add `revision BIGINT NOT NULL DEFAULT 1` to `pages` in `src/schema.sql` and `src/core/pglite-schema.ts`.

Install this function and trigger immediately after the page table/generation trigger section in both files:

```sql
CREATE OR REPLACE FUNCTION bump_page_revision_fn() RETURNS trigger
SET search_path = pg_catalog, public AS $func$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    NEW.revision := 1;
  ELSIF (OLD.type IS DISTINCT FROM NEW.type)
     OR (OLD.page_kind IS DISTINCT FROM NEW.page_kind)
     OR (OLD.title IS DISTINCT FROM NEW.title)
     OR (OLD.compiled_truth IS DISTINCT FROM NEW.compiled_truth)
     OR (OLD.timeline IS DISTINCT FROM NEW.timeline)
     OR (OLD.frontmatter IS DISTINCT FROM NEW.frontmatter)
     OR (OLD.content_hash IS DISTINCT FROM NEW.content_hash)
     OR (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
     OR (OLD.effective_date IS DISTINCT FROM NEW.effective_date)
     OR (OLD.effective_date_source IS DISTINCT FROM NEW.effective_date_source)
     OR (OLD.import_filename IS DISTINCT FROM NEW.import_filename)
     OR (OLD.source_path IS DISTINCT FROM NEW.source_path)
     OR (OLD.chunker_version IS DISTINCT FROM NEW.chunker_version)
     OR (OLD.source_kind IS DISTINCT FROM NEW.source_kind)
     OR (OLD.source_uri IS DISTINCT FROM NEW.source_uri)
     OR (OLD.ingested_via IS DISTINCT FROM NEW.ingested_via)
     OR (OLD.ingested_at IS DISTINCT FROM NEW.ingested_at)
  THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_page_revision_trg ON pages;
CREATE TRIGGER bump_page_revision_trg
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION bump_page_revision_fn();
```

The explicit `ELSE` prevents caller-supplied revision changes on neutral updates and makes the trigger the sole owner of the token.

- [ ] **Step 5: Add the idempotent migration at the current head**

After re-reading `MIGRATIONS` and confirming the latest version, add the next migration (v125 if v124 is still latest) to `src/core/migrate.ts`:

```ts
{
  version: 125,
  name: 'page_revision_cas',
  sql: `
    ALTER TABLE pages
      ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;

    CREATE OR REPLACE FUNCTION bump_page_revision_fn() RETURNS trigger
    SET search_path = pg_catalog, public AS $func$
    BEGIN
      IF (TG_OP = 'INSERT') THEN
        NEW.revision := 1;
      ELSIF (OLD.type IS DISTINCT FROM NEW.type)
         OR (OLD.page_kind IS DISTINCT FROM NEW.page_kind)
         OR (OLD.title IS DISTINCT FROM NEW.title)
         OR (OLD.compiled_truth IS DISTINCT FROM NEW.compiled_truth)
         OR (OLD.timeline IS DISTINCT FROM NEW.timeline)
         OR (OLD.frontmatter IS DISTINCT FROM NEW.frontmatter)
         OR (OLD.content_hash IS DISTINCT FROM NEW.content_hash)
         OR (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
         OR (OLD.effective_date IS DISTINCT FROM NEW.effective_date)
         OR (OLD.effective_date_source IS DISTINCT FROM NEW.effective_date_source)
         OR (OLD.import_filename IS DISTINCT FROM NEW.import_filename)
         OR (OLD.source_path IS DISTINCT FROM NEW.source_path)
         OR (OLD.chunker_version IS DISTINCT FROM NEW.chunker_version)
         OR (OLD.source_kind IS DISTINCT FROM NEW.source_kind)
         OR (OLD.source_uri IS DISTINCT FROM NEW.source_uri)
         OR (OLD.ingested_via IS DISTINCT FROM NEW.ingested_via)
         OR (OLD.ingested_at IS DISTINCT FROM NEW.ingested_at)
      THEN
        NEW.revision := OLD.revision + 1;
      ELSE
        NEW.revision := OLD.revision;
      END IF;
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS bump_page_revision_trg ON pages;
    CREATE TRIGGER bump_page_revision_trg
      BEFORE INSERT OR UPDATE ON pages
      FOR EACH ROW
      EXECUTE FUNCTION bump_page_revision_fn();
  `,
},
```

- [ ] **Step 6: Extend both forward-reference bootstraps**

In each `applyForwardReferenceBootstrap`, add a `pages_revision_exists` probe, type field, `needsPagesRevision` calculation, include it in the early-return/needs-bootstrap condition, and execute:

```sql
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
```

The bootstrap only needs the column before schema replay; the fresh schema blob and migration install/recreate the trigger idempotently afterward.

- [ ] **Step 7: Regenerate the embedded schema**

Run:

```bash
bun run build:schema
```

Expected: `src/core/schema-embedded.ts` changes only as generated output from `src/schema.sql`.

- [ ] **Step 8: Add explicit upgrade tests**

In `test/bootstrap.test.ts`, add a pre-v125 down-mutation test that drops the revision trigger/function/column, sets config version to `124`, calls `initSchema()` twice, and asserts:

```ts
expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
const page = await engine.putPage('test/upgraded-revision', testPage);
expect(page.revision).toBe(1);
const updated = await engine.putPage('test/upgraded-revision', { ...testPage, title: 'v2' });
expect(updated.revision).toBe(2);
```

Add the equivalent real-Postgres test to `test/e2e/postgres-bootstrap.test.ts`, using the file's direct `PostgresEngine.initSchema()` path and restoring the latest schema before the test exits.

- [ ] **Step 9: Run focused schema tests to verify GREEN**

Run:

```bash
bun test test/migrate.test.ts test/bootstrap.test.ts test/schema-bootstrap-coverage.test.ts test/pglite-engine.test.ts
```

Expected: PASS.

With a safe test `DATABASE_URL`, run:

```bash
bun test test/e2e/postgres-bootstrap.test.ts test/e2e/schema-drift.test.ts
```

Expected: PASS; fresh Postgres/PGLite columns remain aligned and upgrade is idempotent.

- [ ] **Step 10: Commit the revision foundation**

```bash
git add src/core/types.ts src/core/utils.ts src/schema.sql src/core/pglite-schema.ts src/core/migrate.ts src/core/postgres-engine.ts src/core/pglite-engine.ts src/core/schema-embedded.ts test/migrate.test.ts test/bootstrap.test.ts test/schema-bootstrap-coverage.test.ts test/pglite-engine.test.ts test/e2e/postgres-bootstrap.test.ts
git commit -m "feat: add page revision tokens"
```

---

### Task 2: Typed Atomic Engine Primitives

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/engine.ts:684-729`
- Modify: `src/core/postgres-engine.ts:1011-1130`
- Modify: `src/core/pglite-engine.ts:963-1071`
- Create: `test/page-conditional-write.test.ts`
- Modify: `test/e2e/engine-parity.test.ts`

**Interfaces:**
- Consumes: `Page.revision` and database trigger from Task 1.
- Produces:

```ts
export type ConditionalPageConflictReason =
  | 'already_exists'
  | 'not_found'
  | 'soft_deleted'
  | 'revision_mismatch';

export type ConditionalPageWriteResult =
  | { status: 'created' | 'updated'; page: Page }
  | {
      status: 'conflict';
      slug: string;
      reason: ConditionalPageConflictReason;
      expected_revision?: number;
      current_revision?: number;
    };

createPageOnly(
  slug: string,
  page: PageInput,
  opts: { sourceId: string },
): Promise<ConditionalPageWriteResult>;

lockPageForConditionalWrite(
  slug: string,
  opts: { sourceId: string },
): Promise<Page | null>;

compareAndSwapPage(
  slug: string,
  page: PageInput,
  expectedRevision: number,
  opts: { sourceId: string },
): Promise<ConditionalPageWriteResult>;
```

`lockPageForConditionalWrite` is transaction-only by contract and includes tombstones. The importer uses it to validate CAS and decide unchanged before taking a version snapshot; the guarded update remains the final invariant.

- [ ] **Step 1: Create the canonical PGLite test fixture and write RED engine tests**

Create `test/page-conditional-write.test.ts` with the repository's canonical fixture:

```ts
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const page = (title: string) => ({
  type: 'note',
  title,
  compiled_truth: `body:${title}`,
  timeline: '',
  frontmatter: {},
});
```

Add tests for:

```ts
test('createPageOnly creates revision 1 then conflicts without overwrite', async () => {
  const first = await engine.createPageOnly('notes/atomic', page('winner'), { sourceId: 'default' });
  expect(first.status).toBe('created');
  if (first.status !== 'created') throw new Error('expected created');
  expect(first.page.revision).toBe(1);

  const second = await engine.createPageOnly('notes/atomic', page('loser'), { sourceId: 'default' });
  expect(second).toEqual({
    status: 'conflict',
    slug: 'notes/atomic',
    reason: 'already_exists',
    current_revision: 1,
  });
  expect((await engine.getPage('notes/atomic'))?.title).toBe('winner');
});

test('createPageOnly reports soft_deleted tombstone', async () => {
  await engine.putPage('notes/tombstone', page('old'));
  await engine.softDeletePage('notes/tombstone', { sourceId: 'default' });
  const tombstone = await engine.getPage('notes/tombstone', { sourceId: 'default', includeDeleted: true });
  const result = await engine.createPageOnly('notes/tombstone', page('new'), { sourceId: 'default' });
  expect(result).toEqual({
    status: 'conflict',
    slug: 'notes/tombstone',
    reason: 'soft_deleted',
    current_revision: tombstone!.revision,
  });
});

test('lock + compareAndSwapPage updates only the expected active revision', async () => {
  const initial = await engine.putPage('notes/cas', page('v1'));
  const result = await engine.transaction(async tx => {
    const locked = await tx.lockPageForConditionalWrite('notes/cas', { sourceId: 'default' });
    expect(locked?.revision).toBe(initial.revision);
    return tx.compareAndSwapPage('notes/cas', page('v2'), initial.revision, { sourceId: 'default' });
  });
  expect(result.status).toBe('updated');
  if (result.status !== 'updated') throw new Error('expected updated');
  expect(result.page.revision).toBe(initial.revision + 1);

  const stale = await engine.compareAndSwapPage('notes/cas', page('stale'), initial.revision, { sourceId: 'default' });
  expect(stale).toEqual({
    status: 'conflict',
    slug: 'notes/cas',
    reason: 'revision_mismatch',
    expected_revision: initial.revision,
    current_revision: initial.revision + 1,
  });
});
```

Also test missing CAS, soft-deleted CAS, and the same slug in two seeded source rows with independent revision sequences.

- [ ] **Step 2: Run the engine test to verify RED**

```bash
bun test test/page-conditional-write.test.ts
```

Expected: FAIL with missing `createPageOnly`, `lockPageForConditionalWrite`, and `compareAndSwapPage` methods.

- [ ] **Step 3: Add shared conditional types and engine contracts**

Add the exact exported types and method signatures from this task's **Interfaces** block to `src/core/types.ts` and `src/core/engine.ts`. Document that:

- all three methods require an explicit `sourceId`;
- `lockPageForConditionalWrite` includes tombstones and must be called inside `transaction()`;
- `compareAndSwapPage` never retries a stale revision;
- expected conflicts are values, not thrown errors.

- [ ] **Step 4: Implement Postgres create-only atomically**

Factor the existing `putPage` input normalization into a private file-local helper (for example `normalizePageWrite(page)`) so legacy upsert, create-only, and CAS use identical hash/default/provenance semantics.

Implement `createPageOnly` with one authoritative statement:

```sql
INSERT INTO pages (...)
VALUES (...)
ON CONFLICT (source_id, slug) DO NOTHING
RETURNING ..., revision
```

When `RETURNING` is empty, issue only a source-qualified diagnostic read including tombstones:

```sql
SELECT revision, deleted_at
FROM pages
WHERE source_id = $source_id AND slug = $slug
LIMIT 1
```

Return `soft_deleted` if `deleted_at` is non-null, otherwise `already_exists`; the insert's unique-key result—not the read—decides atomicity.

- [ ] **Step 5: Implement Postgres lock and defensive CAS**

Implement `lockPageForConditionalWrite` using:

```sql
SELECT id, source_id, slug, type, title, compiled_truth, timeline,
       frontmatter, content_hash, revision, created_at, updated_at, deleted_at,
       source_kind, source_uri, ingested_via, ingested_at
FROM pages
WHERE source_id = $source_id AND slug = $slug
FOR UPDATE
```

Implement `compareAndSwapPage` with a guarded `UPDATE` that mirrors legacy `putPage`'s field and `COALESCE` preservation rules:

```sql
UPDATE pages
SET type = $type,
    page_kind = $page_kind,
    title = $title,
    compiled_truth = $compiled_truth,
    timeline = $timeline,
    frontmatter = $frontmatter,
    content_hash = $content_hash,
    updated_at = now(),
    effective_date = COALESCE($effective_date, pages.effective_date),
    effective_date_source = COALESCE($effective_date_source, pages.effective_date_source),
    import_filename = COALESCE($import_filename, pages.import_filename),
    chunker_version = COALESCE($chunker_version, pages.chunker_version),
    source_path = COALESCE($source_path, pages.source_path),
    source_kind = COALESCE($source_kind, pages.source_kind),
    source_uri = COALESCE($source_uri, pages.source_uri),
    ingested_via = COALESCE($ingested_via, pages.ingested_via),
    ingested_at = COALESCE($ingested_at, pages.ingested_at)
WHERE source_id = $source_id
  AND slug = $slug
  AND deleted_at IS NULL
  AND revision = $expected_revision
RETURNING ..., revision
```

If no row is returned, read the exact row including tombstones and return, in order: `not_found`, `soft_deleted`, or `revision_mismatch` with expected/current revision. Do not retry.

- [ ] **Step 6: Implement exact PGLite parity**

Implement the same methods and result shapes in `src/core/pglite-engine.ts` using positional parameters. Keep SQL predicates, diagnostics, `Number(revision)` conversion, and COALESCE behavior semantically identical.

- [ ] **Step 7: Run engine tests and typecheck**

```bash
bun test test/page-conditional-write.test.ts test/pglite-engine.test.ts
```

Expected: PASS.

```bash
bun run typecheck
```

Expected: PASS; any synthetic `Page` fixtures reported by TypeScript are updated with `revision: 1` rather than making the field optional.

- [ ] **Step 8: Add cross-engine result parity assertions**

In `test/e2e/engine-parity.test.ts`, add a test that runs the same sequence on both engines:

```ts
async function conditionalSequence(eng: BrainEngine) {
  const created = await eng.createPageOnly('test/conditional-parity', {
    type: 'note', title: 'v1', compiled_truth: 'v1', timeline: '', frontmatter: {},
  }, { sourceId: 'default' });
  const conflict = await eng.createPageOnly('test/conditional-parity', {
    type: 'note', title: 'other', compiled_truth: 'other', timeline: '', frontmatter: {},
  }, { sourceId: 'default' });
  if (created.status !== 'created') throw new Error('expected created');
  const updated = await eng.compareAndSwapPage('test/conditional-parity', {
    type: 'note', title: 'v2', compiled_truth: 'v2', timeline: '', frontmatter: {},
  }, created.page.revision, { sourceId: 'default' });
  const stale = await eng.compareAndSwapPage('test/conditional-parity', {
    type: 'note', title: 'stale', compiled_truth: 'stale', timeline: '', frontmatter: {},
  }, created.page.revision, { sourceId: 'default' });
  return { created, conflict, updated, stale };
}
```

Normalize dates/pages out of the comparison and assert statuses, reasons, and revision numbers match exactly.

- [ ] **Step 9: Run real parity and commit**

```bash
bun test test/e2e/engine-parity.test.ts
```

Expected: PASS with a safe test `DATABASE_URL`.

```bash
git add src/core/types.ts src/core/engine.ts src/core/postgres-engine.ts src/core/pglite-engine.ts test/page-conditional-write.test.ts test/e2e/engine-parity.test.ts
git commit -m "feat: add atomic conditional page primitives"
```

---

### Task 3: Conditional Import Transaction and Rollback Semantics

**Files:**
- Modify: `src/core/import-file.ts:300-935`
- Modify: `test/import-file.test.ts`
- Modify: `test/page-conditional-write.test.ts`

**Interfaces:**
- Consumes Task 2 engine methods.
- Produces:

```ts
export type ConditionalWritePrecondition =
  | { mode: 'create_only' }
  | { mode: 'compare_and_swap'; expected_revision: number };

export interface ImportResult {
  slug: string;
  status:
    | 'imported'
    | 'skipped'
    | 'error'
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'conflict';
  chunks: number;
  revision?: number;
  reason?: ConditionalPageConflictReason;
  expected_revision?: number;
  current_revision?: number;
  // existing fields remain
}
```

- Extends `importFromContent(..., opts)` with:

```ts
writePrecondition?: ConditionalWritePrecondition;
```

Legacy callers that omit it retain current `imported`/`skipped` behavior.

- [ ] **Step 1: Write RED import-pipeline tests**

Extend the `mockEngine` support in `test/import-file.test.ts` and add tests that assert:

```ts
test('conditional same hash still evaluates CAS and returns unchanged', async () => {
  const existing = { ...existingPageFixture, content_hash: KNOWN_HASH, revision: 7 };
  const engine = mockEngine({
    getPage: async () => existing,
    lockPageForConditionalWrite: async () => existing,
  });
  const result = await importFromContent(engine, 'notes/same', contentForKnownHash, {
    noEmbed: true,
    writePrecondition: { mode: 'compare_and_swap', expected_revision: 7 },
  });
  expect(result.status).toBe('unchanged');
  expect(result.revision).toBe(7);
  expect((engine as any)._calls.some((c: any) => c.method === 'putPage')).toBe(false);
  expect((engine as any)._calls.some((c: any) => c.method === 'upsertChunks')).toBe(false);
});

test('conditional external-id duplicate does not redirect away from exact slug', async () => {
  const engine = mockEngine({
    findDuplicatePage: async () => ({ slug: 'notes/other', id: 1 }),
    getPage: async (slug: string) => slug === 'notes/other'
      ? { ...otherPage, frontmatter: { id: 'same-id' } }
      : null,
    createPageOnly: async (slug: string) => ({
      status: 'created', page: { ...createdPage, slug, revision: 1 },
    }),
  });
  const result = await importFromContent(engine, 'notes/exact', contentWithId, {
    noEmbed: true,
    writePrecondition: { mode: 'create_only' },
  });
  expect(result.slug).toBe('notes/exact');
  expect(result.status).toBe('created');
});
```

Add integration cases to `test/page-conditional-write.test.ts` for:

- create success writes page, tags, and chunks;
- second create conflict leaves page/chunks/tags/version counts unchanged;
- matching CAS creates exactly one `page_versions` row and increments revision once;
- stale CAS leaves every count/content unchanged;
- same-content matching CAS returns `unchanged`, no version, no projection writes;
- missing and tombstoned CAS return distinct reasons;
- a thrown `addTag`/`upsertChunks` after the page statement rolls back page/revision/version/tags/chunks.

Use DB count snapshots such as:

```ts
async function stateFor(slug: string) {
  const [row] = await engine.executeRaw<any>(`
    SELECT p.title, p.revision,
      (SELECT count(*)::int FROM page_versions pv WHERE pv.page_id = p.id) versions,
      (SELECT count(*)::int FROM content_chunks cc WHERE cc.page_id = p.id) chunks,
      (SELECT count(*)::int FROM tags t WHERE t.page_id = p.id) tags
    FROM pages p WHERE p.source_id = 'default' AND p.slug = $1
  `, [slug]);
  return row ?? null;
}
```

- [ ] **Step 2: Run tests to verify RED**

```bash
bun test test/import-file.test.ts test/page-conditional-write.test.ts
```

Expected: FAIL because `writePrecondition` and conditional result states are not implemented.

- [ ] **Step 3: Extend import types and guard legacy-only early exits**

Add `ConditionalWritePrecondition` and the extended `ImportResult` union. Change the exact same-hash shortcut to legacy-only:

```ts
if (!opts.writePrecondition && existing?.content_hash === hash && !opts.forceRechunk) {
  return { slug, status: 'skipped', chunks: 0, parsedPage };
}
```

Change cross-slug external-ID skip so it is also legacy-only:

```ts
if (sameExternalId && !opts.writePrecondition) {
  return { slug: dup.slug, status: 'skipped', chunks: 0, parsedPage };
}
```

For conditional writes, emit the existing warning but continue against the exact requested `(source_id, slug)`.

- [ ] **Step 4: Move the authoritative conditional decision inside the existing transaction**

Refactor the transaction body around one `writeResult` variable. For legacy mode, preserve the current order and result. For conditional mode:

```ts
const writeResult = await engine.transaction(async tx => {
  if (opts.writePrecondition?.mode === 'create_only') {
    const created = await tx.createPageOnly(slug, pageInput, { sourceId: sourceId ?? 'default' });
    if (created.status === 'conflict') return created;
    await reconcileProjections(tx, created.page);
    return created;
  }

  if (opts.writePrecondition?.mode === 'compare_and_swap') {
    const expected = opts.writePrecondition.expected_revision;
    const locked = await tx.lockPageForConditionalWrite(slug, { sourceId: sourceId ?? 'default' });
    if (!locked) return { status: 'conflict', slug, reason: 'not_found' } as const;
    if (locked.deleted_at) {
      return {
        status: 'conflict', slug, reason: 'soft_deleted',
        expected_revision: expected, current_revision: locked.revision,
      } as const;
    }
    if (locked.revision !== expected) {
      return {
        status: 'conflict', slug, reason: 'revision_mismatch',
        expected_revision: expected, current_revision: locked.revision,
      } as const;
    }
    if (locked.content_hash === hash && !opts.forceRechunk) {
      return { status: 'unchanged', slug, revision: locked.revision } as const;
    }
    await tx.createVersion(slug, { sourceId: sourceId ?? 'default' });
    const updated = await tx.compareAndSwapPage(slug, pageInput, expected, {
      sourceId: sourceId ?? 'default',
    });
    if (updated.status === 'conflict') return updated;
    await reconcileProjections(tx, updated.page);
    return updated;
  }

  // exact existing legacy transaction path
});
```

Extract only the existing transaction-owned projection body into a local nested `reconcileProjections(tx, writtenPage)` function; do not move parsing/chunking/embedding into the transaction and do not move aliases into it.

Compute effective-date inputs from the locked page for CAS rather than trusting the pre-transaction `existing` read. `create_only` uses `nowDate`. Legacy mode keeps existing behavior.

- [ ] **Step 5: Return without out-of-transaction mutations for conflict/unchanged**

Immediately map conditional non-write outcomes after transaction commit:

```ts
if (writeResult.status === 'conflict') {
  return { ...writeResult, chunks: 0, parsedPage };
}
if (writeResult.status === 'unchanged') {
  return { ...writeResult, chunks: 0, parsedPage };
}
```

Only `created`, `updated`, and legacy `imported` proceed to `setPageAliases`. Return `revision` from successful conditional engine pages and preserve existing quarantine/flag fields.

- [ ] **Step 6: Prove rollback and side-effect-free conflicts**

Run:

```bash
bun test test/import-file.test.ts test/page-conditional-write.test.ts
```

Expected: PASS, including the injected projection failure showing no page/revision/version/projection residue.

- [ ] **Step 7: Run affected import consumers and typecheck**

```bash
bun test test/ingestion/put-page-write-through.test.ts test/put-page-frontmatter-parse-guard.test.ts
```

Expected: PASS; legacy import statuses remain compatible.

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit the shared conditional import transaction**

```bash
git add src/core/import-file.ts test/import-file.test.ts test/page-conditional-write.test.ts
git commit -m "feat: integrate conditional page transactions"
```

---

### Task 4: Canonical MCP Operation and Shared Post-Commit Hooks

**Files:**
- Modify: `src/core/operations.ts:782-1162,5414-5420`
- Create: `test/put-page-conditional-operation.test.ts`
- Modify: `test/mcp-tool-defs.test.ts`
- Modify: `test/put-page-namespace.test.ts`
- Modify: `test/put-page-provenance.test.ts`
- Modify: `test/put-page-frontmatter-parse-guard.test.ts`
- Modify: `test/ingestion/put-page-write-through.test.ts`

**Interfaces:**
- Consumes: `importFromContent(..., { writePrecondition })` from Task 3.
- Produces canonical operation:

```ts
put_page_conditional({
  slug: string,
  content: string,
  mode: 'create_only' | 'compare_and_swap',
  expected_revision?: number,
  source_kind?: string,
  source_uri?: string,
  ingested_via?: string,
})
```

- Produces public results:

```ts
{ status: 'created' | 'updated' | 'unchanged'; slug: string; revision: number; chunks: number; ...postHooks }
```

or

```ts
{
  status: 'conflict';
  slug: string;
  reason: 'already_exists' | 'not_found' | 'soft_deleted' | 'revision_mismatch';
  expected_revision?: number;
  current_revision?: number;
}
```

- [ ] **Step 1: Write RED tool-contract and operation tests**

Add to `test/mcp-tool-defs.test.ts`:

```ts
test('put_page_conditional schema is generated from the canonical registry', () => {
  const def = buildToolDefs(operations).find(d => d.name === 'put_page_conditional');
  expect(def).toBeDefined();
  expect(def!.inputSchema.required).toEqual(['slug', 'content', 'mode']);
  expect((def!.inputSchema.properties.mode as any).enum)
    .toEqual(['create_only', 'compare_and_swap']);
  expect((def!.inputSchema.properties.expected_revision as any).type).toBe('number');
  expect(operations.find(o => o.name === 'put_page_conditional')?.scope).toBe('write');
});
```

Create `test/put-page-conditional-operation.test.ts` with one PGLite engine, gateway embedding stub, `resetPgliteState`, a `makeCtx`, and these cases:

```ts
test.each([
  [{ mode: 'create_only', expected_revision: 1 }, 'create_only rejects expected_revision'],
  [{ mode: 'compare_and_swap' }, 'compare_and_swap requires expected_revision'],
  [{ mode: 'compare_and_swap', expected_revision: 0 }, 'positive safe integer'],
  [{ mode: 'compare_and_swap', expected_revision: Number.MAX_SAFE_INTEGER + 1 }, 'positive safe integer'],
])('validates mode/revision coupling', async (params, message) => {
  expect(
    conditionalOp.handler(makeCtx(), { slug: 'notes/validation', content: VALID, ...params }),
  ).rejects.toMatchObject({ name: 'OperationError', code: 'invalid_params' });
});

test('returns create conflict as a normal typed value', async () => {
  const created = await conditionalOp.handler(makeCtx(), {
    slug: 'notes/typed', content: V1, mode: 'create_only',
  });
  const conflict = await conditionalOp.handler(makeCtx(), {
    slug: 'notes/typed', content: V2, mode: 'create_only',
  });
  expect(created.status).toBe('created');
  expect(conflict).toEqual({
    status: 'conflict', slug: 'notes/typed', reason: 'already_exists', current_revision: 1,
  });
});
```

Also assert `unchanged` has no write-through/backstop/lint/auto-link fields and malformed frontmatter returns the same `frontmatter.error: 'unparseable'`, `page_unchanged: true` shape as legacy `put_page`.

- [ ] **Step 2: Run operation tests to verify RED**

```bash
bun test test/put-page-conditional-operation.test.ts test/mcp-tool-defs.test.ts
```

Expected: FAIL because the operation is absent.

- [ ] **Step 3: Extract shared put-page preparation and successful-write hooks**

Refactor the current long `put_page` handler into focused file-local helpers without changing its result:

```ts
type PutPageMode =
  | { kind: 'legacy' }
  | { kind: 'conditional'; precondition: ConditionalWritePrecondition };

async function executePutPage(
  ctx: OperationContext,
  p: Record<string, unknown>,
  mode: PutPageMode,
): Promise<Record<string, unknown>>;

async function runPutPageSuccessHooks(
  ctx: OperationContext,
  slug: string,
  result: ImportResult,
  activePack: ActivePackSummary | undefined,
): Promise<Record<string, unknown>>;
```

`executePutPage` owns, once:

- server-stamped versus local provenance;
- subagent slug fence (with the current operation name supplied for error text);
- dry-run;
- embedding availability;
- active-pack load;
- `importFromContent` call;
- malformed-frontmatter mapping;
- immediate return for conditional `conflict` and `unchanged`;
- invocation of post-hooks only for legacy `imported` and conditional `created`/`updated`.

`runPutPageSuccessHooks` owns the existing unknown-type audit, write-through, auto-link/timeline trust gate, facts, chronicle, and writer lint blocks. Preserve legacy `put_page`'s treatment of `skipped` exactly: only conditional `unchanged`/`conflict` get the new strict no-hook return.

- [ ] **Step 4: Define and validate `put_page_conditional`**

Add:

```ts
const put_page_conditional: Operation = {
  name: 'put_page_conditional',
  description: 'Atomically create an absent page or update an active page at an expected revision. Conflicts are normal typed results and never overwrite.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    content: { type: 'string', required: true, description: putPageContentDescription },
    mode: {
      type: 'string', required: true,
      enum: ['create_only', 'compare_and_swap'],
      description: 'create_only inserts only when the exact source-scoped slug is absent; compare_and_swap updates only expected_revision.',
    },
    expected_revision: {
      type: 'number', required: false,
      description: 'Required positive safe integer for compare_and_swap; forbidden for create_only.',
    },
    source_kind: putPageSourceKindParam,
    source_uri: putPageSourceUriParam,
    ingested_via: putPageIngestedViaParam,
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const mode = p.mode;
    const expected = p.expected_revision;
    if (mode === 'create_only') {
      if (expected !== undefined) {
        throw new OperationError('invalid_params', 'mode=create_only rejects expected_revision');
      }
      return executePutPage(ctx, p, {
        kind: 'conditional', precondition: { mode: 'create_only' },
      });
    }
    if (mode === 'compare_and_swap') {
      if (!Number.isSafeInteger(expected) || (expected as number) <= 0) {
        throw new OperationError(
          'invalid_params',
          'mode=compare_and_swap requires expected_revision to be a positive safe integer',
        );
      }
      return executePutPage(ctx, p, {
        kind: 'conditional',
        precondition: { mode: 'compare_and_swap', expected_revision: expected as number },
      });
    }
    throw new OperationError('invalid_params', `Unknown conditional write mode: ${String(mode)}`);
  },
};
```

Use a conditional provenance stamp (`mcp:put_page_conditional`) for remote calls, while preserving the exact local trust policy. Add `put_page_conditional` adjacent to `put_page` in the exported `operations` array.

- [ ] **Step 5: Add parity regressions to existing security/post-hook suites**

Extend the named existing suites rather than duplicating all fixture setup:

- `test/put-page-namespace.test.ts`: conditional operation rejects out-of-prefix subagent writes before dry-run.
- `test/put-page-provenance.test.ts`: local params are honored; remote payload values are replaced by `mcp:put_page_conditional`; source URI is null.
- `test/put-page-frontmatter-parse-guard.test.ts`: malformed conditional payload is non-mutating and uses the explicit parse-error shape.
- `test/ingestion/put-page-write-through.test.ts`: `created`/`updated` preserve write-through, while `conflict`/`unchanged` never call it.

Use operation lookup assertions that fail loudly:

```ts
const conditionalOp = operations.find(o => o.name === 'put_page_conditional');
if (!conditionalOp) throw new Error('put_page_conditional missing');
```

- [ ] **Step 6: Run focused operation/security tests**

```bash
bun test test/put-page-conditional-operation.test.ts test/mcp-tool-defs.test.ts test/put-page-namespace.test.ts test/put-page-provenance.test.ts test/put-page-frontmatter-parse-guard.test.ts test/ingestion/put-page-write-through.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run legacy put-page regression tests**

```bash
bun test test/put-page-unknown-type-prompt.test.ts test/put-page-content-sanity-gate.test.ts test/put-page-provenance-readback.test.ts test/import-file.test.ts
```

Expected: PASS; `put_page` still returns `created_or_updated` and preserves prior hook behavior.

- [ ] **Step 8: Typecheck and commit**

```bash
bun run typecheck
```

Expected: PASS.

```bash
git add src/core/operations.ts test/put-page-conditional-operation.test.ts test/mcp-tool-defs.test.ts test/put-page-namespace.test.ts test/put-page-provenance.test.ts test/put-page-frontmatter-parse-guard.test.ts test/ingestion/put-page-write-through.test.ts
git commit -m "feat: expose conditional page writes over MCP"
```

---

### Task 5: Real Postgres Concurrency and Rollback Proof

**Files:**
- Create: `test/e2e/page-conditional-write-concurrency.test.ts`
- Modify only if a proven test utility gap exists: `test/e2e/helpers.ts`

**Interfaces:**
- Consumes: complete conditional import API from Tasks 2–4.
- Produces: real-Postgres proof that the database, not client pre-reads, serializes create-only and CAS.

- [ ] **Step 1: Create a safe real-Postgres fixture with independent engines**

Create `test/e2e/page-conditional-write-concurrency.test.ts` using `hasDatabase`, `setupDB`, `teardownDB`, and two or more additional `PostgresEngine` instances connected to the same safe test database:

```ts
const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

function barrier(parties: number) {
  let waiting = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    waiting += 1;
    if (waiting === parties) release();
    await ready;
  };
}
```

Use `beforeAll(setupDB)`, `beforeEach` table cleanup, and `afterAll` to disconnect every extra engine before `teardownDB()`.

- [ ] **Step 2: Write simultaneous create-only test**

Start N=4 writers with unique content/tags and a shared barrier:

```ts
const results = await Promise.all(writers.map(async (eng, i) => {
  await startTogether();
  return importFromContent(eng, 'test/concurrent-create', markdown(i), {
    noEmbed: true,
    sourceId: 'default',
    writePrecondition: { mode: 'create_only' },
  });
}));
```

Assert:

- exactly one `status === 'created'`;
- three `status === 'conflict'` and `reason === 'already_exists'`;
- final page title/body, tags, and chunks all correspond to the same winning payload;
- revision is `1`;
- `page_versions` count is `0`.

- [ ] **Step 3: Write simultaneous same-revision CAS test**

Seed revision 1, then race N=4 CAS writers at `expected_revision: 1`. Assert:

- exactly one `updated`;
- three `revision_mismatch` conflicts;
- final revision is `2`;
- exactly one old-state version exists;
- final chunks/tags match the winning page and no loser projection landed.

- [ ] **Step 4: Write rollback-injection test**

Use a transaction-scoped proxy/decorator around one connected engine that delegates all calls except a chosen dependent write:

```ts
const originalTransaction = engine.transaction.bind(engine);
(engine as any).transaction = (fn: (tx: BrainEngine) => Promise<unknown>) =>
  originalTransaction(tx => fn(new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'upsertChunks') {
        return async () => { throw new Error('injected projection failure'); };
      }
      return Reflect.get(target as object, prop, receiver);
    },
  }) as BrainEngine));
```

Run a matching CAS expected to reject and assert the page content/revision, version count, chunks, and tags are byte-for-byte/count-for-count unchanged. Restore the original method in `finally`.

- [ ] **Step 5: Write source/tombstone isolation test**

Seed source rows `source-a` and `source-b`; race create-only for the same slug in both sources and expect both to create at revision 1. Soft-delete source A and assert another create-only in A returns `soft_deleted` while source B remains active and unchanged.

- [ ] **Step 6: Run the real concurrency suite**

```bash
bun test test/e2e/page-conditional-write-concurrency.test.ts
```

Expected: PASS with a safe test `DATABASE_URL`; no sequential-call substitute is accepted.

- [ ] **Step 7: Repeat the race suite to catch flakiness**

```bash
bun test --rerun-each 5 test/e2e/page-conditional-write-concurrency.test.ts
```

Expected: 5/5 PASS. If the installed Bun does not support `--rerun-each`, run the same exact command in a five-iteration shell loop and require all iterations to pass.

- [ ] **Step 8: Commit concurrency proof**

```bash
git add test/e2e/page-conditional-write-concurrency.test.ts test/e2e/helpers.ts
git commit -m "test: prove conditional page write concurrency"
```

Only stage `test/e2e/helpers.ts` if it actually changed.

---

### Task 6: HTTP MCP Discovery, Typed Conflicts, and Source Binding

**Files:**
- Modify: `test/e2e/http-transport.test.ts`

**Interfaces:**
- Consumes: canonical registry exposure from Task 4; no HTTP transport code changes are expected.
- Produces: authenticated `POST /mcp` proof for discovery, create-only, CAS, normal typed conflicts, source binding, and legacy compatibility.

- [ ] **Step 1: Add a helper that parses MCP tool results**

In `test/e2e/http-transport.test.ts`, add:

```ts
async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`http://localhost:${srv.port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: rpc('tools/call', { name, arguments: args }),
  });
  const body = await response.json();
  return {
    response,
    body,
    result: JSON.parse(body.result.content[0].text),
  };
}
```

- [ ] **Step 2: Add discovery and typed conflict tests**

Extend the existing tools/list test:

```ts
expect(body.result.tools.map((t: any) => t.name)).toContain('put_page_conditional');
```

Add an HTTP sequence:

```ts
const created = await callTool(validToken, 'put_page_conditional', {
  slug: 'test/http-conditional', content: V1, mode: 'create_only',
});
expect(created.body.result.isError).toBeUndefined();
expect(created.result.status).toBe('created');
expect(created.result.revision).toBe(1);

const conflict = await callTool(validToken, 'put_page_conditional', {
  slug: 'test/http-conditional', content: V2, mode: 'create_only',
});
expect(conflict.response.status).toBe(200);
expect(conflict.body.result.isError).toBeUndefined();
expect(conflict.result).toMatchObject({ status: 'conflict', reason: 'already_exists' });

const updated = await callTool(validToken, 'put_page_conditional', {
  slug: 'test/http-conditional', content: V2,
  mode: 'compare_and_swap', expected_revision: created.result.revision,
});
expect(updated.result).toMatchObject({ status: 'updated', revision: 2 });

const stale = await callTool(validToken, 'put_page_conditional', {
  slug: 'test/http-conditional', content: V3,
  mode: 'compare_and_swap', expected_revision: created.result.revision,
});
expect(stale.body.result.isError).toBeUndefined();
expect(stale.result).toMatchObject({
  status: 'conflict', reason: 'revision_mismatch', expected_revision: 1, current_revision: 2,
});
```

- [ ] **Step 3: Add explicit source-binding test**

Insert a second legacy access token with:

```sql
permissions = '{"source_id":"source-http-a"}'::jsonb
```

Seed `source-http-a` and `source-http-b` in `sources`. Call `put_page_conditional` with a payload that includes hostile undeclared fields such as `source_id: 'source-http-b'` and `sourceId: 'source-http-b'`. Assert SQL directly:

```ts
const rows = await getConn().unsafe(
  `SELECT source_id FROM pages WHERE slug = $1 ORDER BY source_id`,
  ['test/http-source-bound'],
);
expect(rows.map((r: any) => r.source_id)).toEqual(['source-http-a']);
```

This proves payload fields cannot override the authenticated context's scalar write floor.

- [ ] **Step 4: Add legacy `put_page` compatibility call**

Call existing `put_page` over the same HTTP server and assert:

```ts
expect(legacy.body.result.isError).toBeUndefined();
expect(legacy.result.status).toBe('created_or_updated');
```

Then `get_page` the row and assert it includes numeric `revision`.

- [ ] **Step 5: Run HTTP E2E**

```bash
bun test test/e2e/http-transport.test.ts
```

Expected: PASS against real Postgres. No source change in `src/mcp/http-transport.ts` should be necessary; if the operation is not discovered, fix the canonical registry rather than adding a second transport registry.

- [ ] **Step 6: Commit HTTP contract proof**

```bash
git add test/e2e/http-transport.test.ts
git commit -m "test: verify conditional writes over HTTP MCP"
```

---

### Task 7: Soft-Delete Revision, Full Regression, and Deployment Verification

**Files:**
- Modify: `test/pages-soft-delete.test.ts`
- Verify only: all implementation files from Tasks 1–6
- Do not modify: the out-of-repo motivating client script from the private implementation handoff

**Interfaces:**
- Consumes: complete feature.
- Produces: final regression evidence and deployed shared-HTTP verification.

- [ ] **Step 1: Add delete/restore revision tests**

Extend the canonical round-trip in `test/pages-soft-delete.test.ts`:

```ts
const before = await engine.getPage('people/judy');
expect(before?.revision).toBe(1);

await engine.softDeletePage('people/judy');
const tombstone = await engine.getPage('people/judy', { includeDeleted: true });
expect(tombstone?.revision).toBe(2);

expect(await engine.restorePage('people/judy')).toBe(true);
const restored = await engine.getPage('people/judy');
expect(restored?.revision).toBe(3);
```

Also assert a second idempotent delete/restore attempt does not advance revision because no row was updated.

- [ ] **Step 2: Run all focused feature tests**

```bash
bun test test/page-conditional-write.test.ts test/put-page-conditional-operation.test.ts test/import-file.test.ts test/migrate.test.ts test/bootstrap.test.ts test/schema-bootstrap-coverage.test.ts test/pages-soft-delete.test.ts test/pglite-engine.test.ts test/mcp-tool-defs.test.ts test/put-page-namespace.test.ts test/put-page-provenance.test.ts test/put-page-frontmatter-parse-guard.test.ts test/ingestion/put-page-write-through.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run all real-Postgres feature tests and tear down cleanly**

```bash
bun test test/e2e/postgres-bootstrap.test.ts test/e2e/schema-drift.test.ts test/e2e/engine-parity.test.ts test/e2e/page-conditional-write-concurrency.test.ts test/e2e/http-transport.test.ts
```

Expected: PASS using only a test-shaped database accepted by `assertSafeE2eDatabaseUrl`; `afterAll` disconnects all engines and servers.

- [ ] **Step 4: Run repository verification and typecheck**

```bash
bun run verify
```

Expected: PASS.

```bash
bun run typecheck
```

Expected: PASS.

```bash
bun run check:all
```

Expected: PASS, including source-id projection and test-isolation checks. Do not add an allowlist exception for the new PGLite test files.

- [ ] **Step 5: Run the complete test suite appropriate to this checkout**

```bash
bun run test:full
```

Expected: PASS, including E2E when `DATABASE_URL` is configured; if the CRLF-sensitive wrapper itself fails before launching tests, run its documented underlying focused/unit/slow/E2E commands separately and report the wrapper defect rather than claiming a green full suite.

- [ ] **Step 6: Recheck generated schema, branch, ancestry, diff, and forbidden changes**

```bash
bun run build:schema
git diff --exit-code src/core/schema-embedded.ts
git status --short --branch
git merge-base --is-ancestor 8d3c9989 HEAD
git merge-base --is-ancestor caeb4321 HEAD
git diff --name-only 7276c414..HEAD
git diff --name-only 7276c414..HEAD -- .claude .codex .mcp.json
```

Expected:

- schema regeneration leaves no diff;
- both ancestry commands exit 0;
- no MCP config path changed;
- no stdio server/config was added;
- the out-of-repo motivating client script is absent from the diff.

Verify that script's supplied SHA-256 remains unchanged using the private implementation handoff's exact path and a Windows-safe `Get-FileHash -LiteralPath` invocation (PowerShell, not Bash path parsing).

Expected SHA-256:

```text
70cc723aca544eabab36df2058ba5fbddf3367408bc297097d4e617f2dc1b2e8
```

- [ ] **Step 7: Commit final regression additions**

```bash
git add test/pages-soft-delete.test.ts
git commit -m "test: cover conditional page revision lifecycle"
```

If verification required legitimate source/test corrections, stage those exact reviewed paths in the same commit or a narrowly named follow-up commit; never use `git add .` on the live checkout.

- [ ] **Step 8: Verify the installed files survived concurrent writers**

Re-stat and search for unique implementation tokens after the final test run, including:

```bash
git status --short
rg -n "put_page_conditional|bump_page_revision_fn|compareAndSwapPage" src test
```

Expected: the unique tokens are present in the intended files and no sibling session overwrote the implementation after tests ran.

Before any live restart, stop and obtain explicit user confirmation. The implementation and test work is complete without a deployment; a restart is a separate outward-facing action.

- [ ] **Step 9: Restart only the existing supervised shared HTTP service after explicit approval**

After approval, identify the already-configured supervisor/task for `gbrain serve --http --port 7483`, verify its command points through the deployed main-checkout junction lineage described in the private deployment handoff, and restart that existing service only. Do not launch a Bash-backgrounded server, create a new service, or add a stdio MCP process.

- [ ] **Step 10: Verify the live shared service**

First probe unauthenticated health:

```bash
curl -fsS http://127.0.0.1:7483/health
```

Expected: HTTP 200 with `status: "ok"` and `transport: "http"`.

Using the existing authenticated MCP credential path (never print the token), call `tools/list` on `http://127.0.0.1:7483/mcp` and confirm `put_page_conditional` is present.

Use a disposable source-scoped slug under an authorized test prefix to execute:

1. `create_only` → `created`, revision 1;
2. second `create_only` → normal `conflict/already_exists`, no `isError`;
3. CAS at revision 1 → `updated`, revision 2;
4. stale CAS at revision 1 → normal `conflict/revision_mismatch`, current revision 2;
5. `get_page` → winner content and revision 2;
6. legacy `put_page` on another disposable slug → `created_or_updated`.

Read the disposable rows back before cleanup. Use existing explicit delete/purge test procedures only if cleanup is required and authorized; do not hide verification by deleting unexpected pre-existing data.

- [ ] **Step 11: Record final state without pushing**

```bash
git status --short --branch
git log --oneline --decorate -8
```

Expected: implementation commits are local on `claude/page-conditional-cas-design`, working tree is clean, nothing was pushed, both auth commits remain ancestors, and only the existing shared HTTP service was restarted.

---

## Self-Review Checklist

- **Spec coverage:** Tasks cover additive revision reads, trigger-owned all-writer advancement, create-only/CAS atomicity, same-hash CAS ordering, exact-key dedup behavior, tombstones, source isolation, provenance, frontmatter, namespace fences, transaction projections, rollback, post-hook gating, schema/migration/bootstrap parity, real concurrency, HTTP transport, legacy compatibility, and deployment constraints.
- **No placeholders:** Every code-producing step names exact files, signatures, SQL, test assertions, commands, and expected outcomes. Migration numbering includes an explicit recheck because the repository can advance concurrently.
- **Type consistency:** `expected_revision` is snake_case at public/import result boundaries; engine methods use `expectedRevision` as a positional TypeScript argument. Engine success contains `page`; import/operation success flattens to `revision` and `chunks`. Conflict reasons and fields remain identical through engine, import, operation, and HTTP.
- **Behavior boundary:** Only changed CAS creates a version; create, conflicts, and unchanged do not. Only created/updated conditional writes run successful-write hooks. Legacy `put_page` retains current upsert, skip, and post-hook behavior.
- **Deployment boundary:** No worktree deployment assumption, no new stdio server, no package downgrade, no push, no bye-fallback edit, and no restart before all verification passes.
