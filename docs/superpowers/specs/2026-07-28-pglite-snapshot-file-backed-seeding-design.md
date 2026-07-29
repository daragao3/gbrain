# PGLite snapshot seeding for fresh file-backed dataDirs

**Date:** 2026-07-28
**Status:** design approved, pending implementation
**Area:** `src/core/pglite-engine.ts`, test bootstrap cost

## Problem

A cold `gbrain init --migrate-only` against a fresh file-backed PGLite brain takes
~109s on Windows. Timestamping every `[N] name...` / `[N] ✓ name` line that
`runMigrations` writes to stderr decomposes it as:

| phase | time | share |
|---|---|---|
| preamble (bun start + `PGlite.create()` initdb + schema blob) | ~89.9s | 82% |
| all 119 migrations together | ~15.4s | 14% |
| epilogue | ~3.9s | 4% |

Per-migration: median 0ms, p90 899ms, max 2301ms. **Squashing or reordering the
`MIGRATIONS` array buys ~15s of ~110s and is not worth doing.** The cost is
PGLite's cold WASM `initdb` plus applying the schema blob, before the migration
loop starts.

`src/core/pglite-engine.ts` already has a snapshot fast-restore that skips
`initdb` entirely by passing a `loadDataDir` Blob to `PGlite.create()`, and sets
`_snapshotLoaded` so `initSchema()` returns immediately. It is restricted to
**in-memory** brains by a `!dataDir` guard. The tests that pay the bootstrap use
**file-backed** brains, so they get no benefit.

## Findings (verified, not assumed)

Probed against `@electric-sql/pglite` **0.4.3**, the version this repo resolves.

**1. The API supports it.** `PGlite.create({ dataDir, loadDataDir })` accepts both.
A blob dumped from an **in-memory** PGlite loads into a **file-backed** dataDir —
the exact cross-mode transfer this design needs — and the state is durable across
close and reopen. No explicit `syncToFs()` is required on the Node FS path.

**2. It is a hard throw, not a soft fallback.** The runtime branches on
`loadDataDir` alone; `dataDir` is irrelevant to that branch:

```js
if (r.loadDataDir) {
  if (FS.analyzePath(PGDATA + "/PG_VERSION").exists)
    throw new Error("Database already exists, cannot load from tarball");
```

So the existing `!dataDir` guard is stricter than the API requires, but passing
`loadDataDir` at an already-populated dataDir **throws**. The current contract
("snapshot is just an optimization, never authoritative", silent fallback on any
problem) does not survive that without explicit handling.

**3. Blast radius is the binding constraint.** `scripts/ci-local.sh` exports
`GBRAIN_PGLITE_SNAPSHOT` **globally for all 4 unit shards**. Merely dropping the
`!dataDir` guard would switch every file-backed PGLite test in the suite onto
snapshot-seeding simultaneously. That rules out the one-line version.

**4. Latent bug this would activate.** `_snapshotLoaded` is set in `connect()` and
never reset. Harmless today, because in-memory `reconnect()` is a documented
no-op. A file-backed `reconnect()` genuinely re-opens the dataDir, so the flag
must reset.

**5. Relative-path gotcha.** The env var holds `test/fixtures/pglite-snapshot.tar`.
Subprocess tests spawning from a tmpdir cwd would silently miss the snapshot and
fall back to a slow boot, reporting "no win" for the wrong reason.

### Measured probe numbers

Windows 11, 14 concurrent `bun` processes, trivial schema (not gbrain's):

| step | result | time | concurrent `bun` |
|---|---|---|---|
| build snapshot blob (in-mem create + DDL + dump) | 39.7 MB tar | 54.8s | 14 |
| `create({ dataDir, loadDataDir })` | works, data present | 27.1s | 14 |
| reopen same dataDir, no `loadDataDir` | persisted | 12.5s | 14 |
| `loadDataDir` onto populated dataDir | throws | — | 14 |
| bare file-backed `create({ dataDir })`, no gbrain schema | cold `initdb` floor | 42.3s | 17 |

Two things follow. The ~40 MB untar-and-write-through is real work, not free — the
seed measured *slower* than a plain resume (27.1s vs 12.5s). But seeding is
meaningfully **faster than `initdb` itself** (27.1s vs 42.3s), before counting the
schema blob and all 119 migrations it also skips. That is the first direct evidence
the win survives into the file-backed case.

These are still trivial-schema numbers and are **not** a projection of the gbrain
win (see Open question).

**dataDir layout, verified:** `PG_VERSION` sits at the dataDir root, alongside
`base/`, `global/`, `pg_wal/`, `postgresql.conf`, etc. So the emptiness pre-check is
`!existsSync(join(dataDir, 'PG_VERSION'))`. This mattered enough to verify because a
check looking in the wrong place fails **closed** — the feature would silently never
engage and the benchmark would report "no win" for an unrelated reason.

## Scope: test-only

User brains are **out of scope**. Four reasons:

- A real brain pays this cost once, ever.
- The snapshot must be **built** first (~90s). For a single brain that costs more
  than it saves.
- A ~40 MB tar cannot ship in the package, so users would build locally and lose
  the benefit anyway.
- Blast radius: a wrong-schema seed on a real brain is a data-integrity failure. In
  tests it is a red test. Same hash guard, very different consequence.

## Design

### Gating

Alternatives considered:

| option | behaviour | verdict |
|---|---|---|
| A. drop the `!dataDir` guard | all file-backed tests in all 4 shards switch at once | rejected — uncontrolled |
| B. second flag `GBRAIN_PGLITE_SNAPSHOT_SEED_FILE=1` | opt-in per test file; in-memory path unchanged | **chosen** |
| C. path allowlist (tmpdir only) | implicit, no flag | rejected — magic; tests legitimately use non-tmp dirs |

B is chosen because it keeps the existing in-memory behaviour provably unchanged,
which matters precisely because `ci:local` turns the base variable on globally.

### Change

At `src/core/pglite-engine.ts` (currently lines ~302-314):

```ts
this._snapshotLoaded = false;                    // finding 4: reset per connect
let loadDataDir: Blob | undefined;
if (process.env.GBRAIN_PGLITE_SNAPSHOT && snapshotEligible(dataDir)) {
  const snap = tryLoadSnapshot(resolveSnapshotPath(process.env.GBRAIN_PGLITE_SNAPSHOT));
  if (snap) { loadDataDir = snap; this._snapshotLoaded = true; }
}
```

**`snapshotEligible(dataDir)`** returns true when either:
- `!dataDir` — existing in-memory behaviour, unchanged; or
- `dataDir` is set **and** `GBRAIN_PGLITE_SNAPSHOT_SEED_FILE === '1'` **and** the
  dataDir is empty (does not exist, or exists without a `PG_VERSION`).

**Catch-and-retry.** If `PGlite.create()` throws **and** `loadDataDir` was passed
**and** the message matches `Database already exists, cannot load from tarball`,
retry once without `loadDataDir`. The emptiness pre-check is a best-effort
optimization; this catch is the authority, and it preserves the "never block on a
snapshot problem" contract against the TOCTOU window between check and open.
Without it, this change converts a slow boot into a crash.

The retry must be **narrow on all three conditions**. Every other failure — and any
failure of the retry itself — falls through unchanged to the existing
`classifyPgliteInitError` / `buildPgliteInitErrorMessage` path, which releases the
lock and produces the actionable `bunfs` / `macos-26-3` / `corrupt` hint. A broad
catch here would swallow genuine init failures and regress that diagnostic surface.

**`resolveSnapshotPath(p)`** absolutizes a relative path against the repo root,
fixing finding 5.

**`_snapshotLoaded = false`** at the top of `connect()`, fixing finding 4.

Staleness handling is **unchanged**: `tryLoadSnapshot` still compares the sidecar
`.version` file against the current `MIGRATIONS` + schema hash and returns null on
mismatch, falling through to a normal `initSchema()`. A stale snapshot restoring an
out-of-date schema would be far worse than a slow boot, so this guard is preserved
exactly as-is and is covered by a dedicated test below.

### Data flow

```
connect(config)
  └─ dataDir = config.database_path || undefined
  └─ _snapshotLoaded = false
  └─ snapshotEligible(dataDir)?
       ├─ no  → PGlite.create({ dataDir })                  [unchanged path]
       └─ yes → tryLoadSnapshot(resolveSnapshotPath(env))
                  ├─ null (missing/stale/corrupt) → normal init
                  └─ Blob → PGlite.create({ dataDir, loadDataDir })
                              └─ throws "already exists" → retry without blob
  └─ initSchema() → returns immediately iff _snapshotLoaded
```

## Testing

- **`snapshotEligible` truth table** (pure unit, no PGLite): in-memory; file+flag+empty;
  file+flag+populated; file, no flag; file+flag+dataDir absent.
- **Staleness fallback**: corrupt the `.version` sidecar, assert a normal init runs and
  the engine does **not** throw.
- **Equivalence — the load-bearing one**: a dataDir seeded from snapshot and a dataDir
  built by cold init must land on the same canonical migration head,
  `engine.getConfig('version')`. This is the safety net for the entire idea; without it
  the feature is unfalsifiable.
- **Non-regression**: `test/bootstrap.test.ts` and `test/schema-bootstrap-coverage.test.ts`
  already `delete process.env.GBRAIN_PGLITE_SNAPSHOT` so they keep exercising cold init.
  Confirm the new flag does not re-enable seeding there.

## Benchmark result and decision

The alternating A/B benchmark ran three fresh file-backed brains per arm under 8–9
concurrent Bun processes. Every timed init and every canonical-head probe exited 0;
all six observed `config.version` 124.

| Arm | Median | Range | Spread |
|---|---:|---:|---:|
| Cold | 32.788s | 32.581–35.241s | 2.660s |
| Seeded | 18.181s | 14.873–19.159s | 4.286s |

Snapshot seeding delivered a **1.80x median speedup**. The seeded median is better
than the 30–40s proceed gate and far below the ~80s abandon threshold. **Decision:
proceed with file-backed snapshot seeding.**

## Out of scope

- Extending seeding to real user brains.
- Squashing or reordering the `MIGRATIONS` array (measured at ~15s of ~110s).
- Changing `serve`'s connect-before-`app.listen` ordering.
- Shrinking the budgets in `test/helpers/pglite-spawn-budget.ts`, which lives on a
  different branch and is not present here.
