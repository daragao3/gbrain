# Task 5 Report: Real PostgreSQL Concurrency and Rollback Proof

## Outcome

`DONE_WITH_CONCERNS`

Task 5 is implemented as a test-only change in the exact required file:

- `test/e2e/page-conditional-write-concurrency.test.ts`

No production file, dependency, or existing E2E helper changed.

## Isolation and database safety

- Starting commit: `4a9c4fe3c0ef3abd4f14adf8943c06961dc9cecc`.
- Required ancestors verified: `8d3c9989`, `caeb4321`, and `e16a5876`.
- Disposable PostgreSQL container: `task5-pg-a491e265`.
- The selected database was queried before database-writing tests and returned `task5_test_a491e265`.
- The verified name is not `gbrain_db`.
- Four independent writer `PostgresEngine` instances use separate instance-owned pools with `poolSize: 1`; the observer and rollback-injection engine are also independent connections.
- No full database URL, token, or password was printed in user-facing output or this report.
- The shared `:7483` service was not used, changed, migrated, or restarted.
- The live checkout was not edited.

## TDD and scope discovery

Code-graph calls were attempted before editing. `code_def` reported `not_built`; `code_callers` and `code_blast` reported that no source was in scope. Scope was therefore established from the required brief, plan, repository instructions, `docs/TESTING.md`, `docs/architecture/KEY_FILES.md`, the existing conditional-write tests, and the relevant implementation definitions.

The initial real-PostgreSQL RED had two meaningful failures:

1. The version snapshot expectation assumed the old frontmatter carried a title, while the persisted version correctly returned no frontmatter title.
2. The first rollback injection did not reach the dependent projection write and timed out instead of producing the required rejection.

Subsequent REDs exposed that imported tags are add-only enrichment state and that a default 5-second `beforeEach` timeout is too short for repeated real-PostgreSQL truncation under load. The final harness uses the persisted old compiled truth as the version proof, models add-only tags, injects failure on a transaction-local engine, gives cleanup a bounded 30-second hook timeout, and keeps rollback under a separate suite lifecycle in the same required test file.

No reusable gap in `test/e2e/helpers.ts` was proven, so it was not changed.

## Real-PostgreSQL proofs

The new suite proves all required behavior end-to-end through conditional `importFromContent`:

1. Four simultaneous create-only imports pass a real promise barrier on four independent connections. Exactly one returns `created`; three return typed `already_exists` conflicts at revision 1. The page, compiled truth, tags, and chunks identify one winner, with no loser body/chunk state and zero versions.
2. Four simultaneous CAS imports from expected revision 1 pass a second real barrier. Exactly one returns `updated`; three return typed `revision_mismatch` conflicts reporting current revision 2. The final row is revision 2, exactly one old-state version exists, and no losing body/chunk projection lands.
3. A transaction-local `upsertChunks` failure rejects the CAS. A complete pre/post snapshot proves page title/body, revision, version rows, tags, and chunks are unchanged.
4. The same slug is created independently in `source-a` and `source-b`, each at revision 1. Tombstoning source A advances only A and yields a typed `soft_deleted` create-only conflict; the complete source-B snapshot remains unchanged and active.
5. A numeric-v125 bootstrap with no revision column, function, or trigger advances to v126 and proves `pages.revision` is `BIGINT NOT NULL DEFAULT 1`, `bump_page_revision_fn()` exists, and `bump_page_revision_trg` exists and is enabled.

## Verification

Final suite and repetition after the last test edit:

- Required suite once: **4 pass, 0 fail, 94 assertions** in 18.70s.
- Required suite with `--rerun-each 5`: **20 pass, 0 fail** in 95.31s.

Relevant regression and static gates:

- PostgreSQL bootstrap: **5 pass, 0 fail**.
- Full engine parity rerun: **25 pass, 0 fail**.
- Targeted conditional-write engine parity: **1 pass, 0 fail**.
- Schema bootstrap coverage: **9 pass, 0 fail**.
- Existing PGLite conditional-write suite: **13 pass, 0 fail**.
- `bun run typecheck`: exit 0.
- `bun run verify`: **34 checks passed, 0 failed**.
- `git diff --check`: exit 0.
- Base and all three required ancestors: verified.

## Concerns

- `test/e2e/migration-flow.test.ts` ran 3/4 tests successfully, but its fresh-install case failed only at the existing Windows POSIX-mode assertion: expected `0600`, received synthesized `0666` on this noacl filesystem. Its migration phases and PostgreSQL smoke checks completed. The Task 5 branch does not touch that test or its code path.
- The first full engine-parity run had one unrelated relational-fanout winner-selection mismatch between two equivalent multi-seed paths. A fresh full rerun passed all 25 tests, and the conditional page-write parity test passed independently. No related code changed in Task 5.
- Bun 1.3.11 crashed after earlier forcibly terminated, lock-blocked experimental rollback runs. The final independent-connection/lifecycle test completed once and across all five repeats without timeout, connection error, or crash.
