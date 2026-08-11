# Atomic Conditional Page Writes

**Status:** Approved design

**Date:** 2026-07-29

## Summary

GBrain's existing `put_page` operation is an unconditional upsert. A client can read an exact slug, observe absence, and issue one `put_page`, but another writer can create or change the page between that read and the upsert. Post-write read-back detects the resulting conflict only after one writer may already have overwritten the other.

Add a separate `put_page_conditional` operation with atomic create-only and revision-based compare-and-swap semantics. Preserve `put_page` unchanged for compatibility. Both Postgres and PGLite must enforce the precondition in the database transaction that writes the page and its dependent projections.

## Goals

- Prevent an absent-page creation race using the existing `(source_id, slug)` unique constraint.
- Prevent stale updates using a stable, page-local revision token.
- Keep existing `put_page` behavior and schema compatible for current clients.
- Expose the operation through the contract-generated MCP surface, including the existing shared Streamable HTTP server at `http://127.0.0.1:7483/mcp`.
- Preserve source isolation, remote provenance stamping, subagent slug fences, frontmatter validation, chunking, embedding, and successful-write post-hooks.
- Provide typed, machine-readable conflict results without treating an expected write conflict as a transport failure.
- Maintain Postgres/PGLite behavior parity and verify real concurrent writers against Postgres.

## Non-goals

- Do not change `put_page` from last-writer-wins upsert semantics.
- Do not add an HTTP route outside MCP or add any stdio GBrain server.
- Do not make the database and filesystem one distributed ACID transaction.
- Do not implicitly restore or replace soft-deleted pages.
- Do not use content hashes or the cache-oriented `generation` field as the public CAS token.
- Do not make chunks, tags, links, embeddings, or other derived projections part of the page revision.

## Public API

Add one write-scoped operation to the canonical operation registry:

```ts
put_page_conditional({
  slug,
  content,
  mode: 'create_only' | 'compare_and_swap',
  expected_revision?,
  source_kind?,
  source_uri?,
  ingested_via?,
})
```

Rules:

- `mode: 'create_only'` rejects `expected_revision`.
- `mode: 'compare_and_swap'` requires `expected_revision` to be a positive safe integer.
- The authenticated operation context supplies `source_id`; callers cannot select another source in the payload.
- The optional provenance fields follow the same policy as `put_page`: trusted local callers may provide them, while remote callers receive server-stamped provenance.
- The operation applies the same subagent slug-prefix fence and frontmatter validation as `put_page`.
- `put_page` keeps its existing parameters, result behavior, and unconditional upsert semantics.

### Success results

```ts
type ConditionalPutSuccess = {
  status: 'created' | 'updated' | 'unchanged';
  slug: string;
  revision: number;
  chunks: number;
  // Existing successful post-hook fields may be included.
};
```

- `created` means the operation atomically won an absent-key insert.
- `updated` means the expected revision matched and the transaction committed a changed page.
- `unchanged` means the expected revision matched and the normalized page hash was already equal. It performs no mutation, does not increment the revision, and does not run successful-write post-hooks.

### Conflict results

Conflicts are typed normal tool results (`isError: false`), not MCP errors or HTTP 409 responses:

```ts
type ConditionalPutConflict = {
  status: 'conflict';
  slug: string;
  reason:
    | 'already_exists'
    | 'not_found'
    | 'soft_deleted'
    | 'revision_mismatch';
  expected_revision?: number;
  current_revision?: number;
};
```

- `create_only` returns `already_exists` for an active row and `soft_deleted` for a tombstone.
- `compare_and_swap` returns `not_found`, `soft_deleted`, or `revision_mismatch` as applicable.
- Conflict responses never include current page content.
- A conflict confirms that no page or dependent projection mutation occurred.
- Transport timeout/reset remains ambiguous. Clients may resolve ambiguity with `get_page`; they must not fall back to unconditional `put_page`.

### Parse errors

Malformed frontmatter returns the same explicit non-mutating shape used by `put_page`, including `frontmatter.error: 'unparseable'` and `page_unchanged: true`.

### Read contract

Add `revision` to the `Page` model and to page projections returned by `get_page`. Conditional success and conflict results expose the relevant revision directly. Existing clients tolerate the additive field.

## Revision model

Add this schema field:

```sql
revision BIGINT NOT NULL DEFAULT 1
```

`revision` is a page-local optimistic-concurrency token. It is separate from `generation`, whose contract remains internal query-cache invalidation.

A database trigger owns revision advancement so every page-row writer, including legacy operations, participates without relying on application code to remember an increment.

### Revision-changing fields

Increment `revision` exactly once when any meaningful client-observable page state changes:

- `type`
- `page_kind`
- `title`
- `compiled_truth`
- `timeline`
- `frontmatter`
- `content_hash`
- `deleted_at`
- `effective_date`
- `effective_date_source`
- `import_filename`
- `source_path`
- `chunker_version`
- `source_kind`
- `source_uri`
- `ingested_via`
- `ingested_at`

A newly inserted page starts at revision `1`.

### Revision-neutral fields and projections

Do not advance `revision` for internal, derived, or observational state:

- `emotional_weight`
- `salience_touched_at`
- `last_retrieved_at`
- `links_extracted_at`
- `contextual_retrieval_mode`
- `corpus_generation`
- cache-oriented `generation`
- chunks, tags, links, timeline-entry projections, embedding signatures, or other tables

This prevents background maintenance from invalidating a client edit token. One logical conditional write advances the revision at most once even when the transaction updates derived state afterward.

## Atomic database operations

### Create-only

Creation uses the authoritative composite key:

```sql
INSERT INTO pages (...)
VALUES (...)
ON CONFLICT (source_id, slug) DO NOTHING
RETURNING ..., revision;
```

- A returned row means the caller won creation.
- Zero returned rows means an active or soft-deleted row already owns the key.
- A source-qualified diagnostic read may distinguish `already_exists` from `soft_deleted`, but it does not decide atomicity; the unique constraint already did.
- Only a successful insert proceeds to transactional projection writes.
- No pre-read can authorize or substitute for this insert decision.

### Compare-and-swap

Within one engine transaction:

1. Read `(source_id, slug)` including tombstones with a row lock.
2. Return `not_found` if no row exists.
3. Return `soft_deleted` if `deleted_at` is non-null.
4. Compare the row's revision with `expected_revision`; return `revision_mismatch` if unequal.
5. If the normalized incoming hash equals the row's hash, return `unchanged` with the current revision and perform no mutation.
6. Snapshot the old page state with the existing version mechanism.
7. Execute an update guarded again by source, slug, active state, and expected revision:

   ```sql
   UPDATE pages
      SET ...
    WHERE source_id = $source_id
      AND slug = $slug
      AND deleted_at IS NULL
      AND revision = $expected_revision
   RETURNING ..., revision;
   ```

8. If the defensive update returns no row, return a conflict without projections.
9. Reconcile transaction-owned dependent state.
10. Commit the snapshot, page, and dependent projections together.

The row lock establishes the normal serialized path. The conditional `UPDATE` remains a defensive invariant.

### Transaction contents

A successful conditional transaction contains:

- page insertion or guarded update
- prior-version snapshot for a changed CAS update
- contextual retrieval state
- tag additions according to current add-only behavior
- chunk upsert or deletion
- embedding signature state
- existing in-transaction document-to-code link work

Any exception rolls back the page, revision, version snapshot, and all transaction-owned projections.

Parsing, content validation, hashing, chunking, and external embedding remain outside the database transaction to avoid holding a row lock during expensive computation. Their output is provisional until the atomic precondition succeeds.

## Import pipeline integration

Refactor the existing import path so `put_page` and `put_page_conditional` share parsing, sanitization, hashing, chunk preparation, embedding, effective-date calculation, and projection reconciliation. The conditional operation supplies an explicit write precondition to the transactional stage.

Important differences for conditional writes:

- The current pre-transaction same-hash shortcut must not return before evaluating the create/CAS precondition.
- Cross-slug identity dedup may warn, but it must not redirect a conditional result to another slug or bypass exact-key evaluation.
- `create_only` cannot degrade into an upsert.
- `compare_and_swap` cannot retry against a newer revision.

## Soft-deleted pages

A tombstone still owns `(source_id, slug)` and always conflicts:

- `create_only` does not treat it as absent.
- `compare_and_swap` does not replace or restore it, even when the revision matches.
- Clients use the existing explicit `restore_page` operation when restoration is desired.
- `delete_page` and `restore_page` advance revision through the database trigger.

This preserves the 72-hour recovery contract and prevents hidden resurrection or destruction of deleted content.

## Post-commit behavior

For `created` and `updated`, preserve the current DB-first behavior:

1. Commit the database transaction.
2. Run filesystem write-through best-effort.
3. Run eligible auto-link/timeline, lint, fact, and chronicle hooks under the same trust gates as `put_page`.
4. Report nonfatal post-hook outcomes in the result.

`conflict`, `unchanged`, and parse-error results run no successful-write post-hooks. The system does not claim cross-resource ACID between Postgres/PGLite and the filesystem.

## Engine and schema changes

Maintain lockstep behavior across both engines:

- Extend `BrainEngine` with typed conditional page-write primitives.
- Implement source-qualified create-only and CAS behavior in `PostgresEngine` and `PGLiteEngine`.
- Add `revision` to `Page`, row conversion, and all necessary page projections.
- Update `src/schema.sql`, generate `src/core/schema-embedded.ts`, and update the PGLite bootstrap/migration path.
- Add an idempotent migration for the revision column and trigger.
- Extend bootstrap coverage and schema-drift tests for fresh and upgraded brains.

No separate HTTP implementation is required. Adding `put_page_conditional` to the canonical operations array exposes it through stdio and the existing authenticated HTTP MCP dispatcher. This project must not add or configure a new stdio GBrain server.

## Testing

### PGLite regression tests

Cover:

- initial create-only success at revision 1
- second create-only conflict with no page, chunk, tag, or version changes
- matching-revision CAS update and one revision increment
- stale CAS conflict with no side effects
- same-content CAS returning `unchanged` without increment or hooks
- distinct missing and soft-deleted conflicts
- delete/restore revision increments
- revision-neutral maintenance field updates
- independent revision sequences for the same slug in separate sources
- unchanged legacy `put_page` upsert behavior
- additive `revision` in `get_page`
- malformed-frontmatter, source-binding, provenance, and subagent-fence parity
- exact-key evaluation despite cross-slug same-content detection

Use the repository's canonical one-engine-per-file PGLite fixture and reset helper.

### Real Postgres concurrency tests

Use independent engine connections and synchronization barriers rather than sequential calls:

1. **Simultaneous create-only:** N writers target one absent key. Exactly one returns `created`; all others conflict; final content and projections belong only to the winner; losing writers create no version rows.
2. **Simultaneous CAS:** N writers use the same current revision. Exactly one returns `updated`; all others return `revision_mismatch`; revision advances once; one old-state version exists; final projections belong only to the winner.
3. **Rollback injection:** force a dependent projection failure after the conditional page statement and verify the page, revision, version, chunks, and tags all roll back.
4. **Source/tombstone isolation:** the same slug can be created concurrently in different sources, while a tombstoned key is never treated as absent.

### Contract and transport tests

- Pin operation parameters, write scope, and mode validation.
- Pin typed conflicts as normal MCP results (`isError: false`).
- Require Postgres/PGLite engine parity.
- Exercise authenticated `POST /mcp` discovery and create/stale-CAS calls against a real Postgres HTTP server.
- Confirm HTTP source binding prevents payload-based source selection.
- Confirm existing `put_page` discovery and behavior remain compatible.

## Deployment constraints and verification

The live `:7483` process runs TypeScript source from `C:\Users\diego\gbrain` through a global-package junction. Editing the main checkout is therefore the deploy on the next supervised restart; a worktree is not deployed.

The approved baseline is commit `1d741e1a09876844077a065dbb0f0e5fbd92a74b`, which contains both local auth-hardening commits:

- `8d3c9989` — bounded bearer-token lookup and retryable 503 behavior
- `caeb4321` — debounced, nonblocking legacy-token telemetry

Implementation must preserve both commits as ancestors and must not branch from the older `origin/master` lineage that lacks them.

Before restarting the shared service:

1. Generate the embedded schema from `src/schema.sql`.
2. Run focused operation, PGLite, migration, and concurrency tests.
3. Run real Postgres migration, concurrency, and HTTP E2E tests; tear down the test database.
4. Run repository verification and type checking.
5. Recheck the main-checkout branch, diff, and both auth ancestors.
6. Restart only the existing supervised shared HTTP service.
7. Verify unauthenticated `/health`.
8. Verify authenticated MCP discovery includes `put_page_conditional`.
9. Exercise a disposable source-scoped create/conflict/CAS sequence over `http://127.0.0.1:7483/mcp`.
10. Confirm legacy `put_page` still succeeds.
11. Confirm no stdio server or MCP configuration was added.
