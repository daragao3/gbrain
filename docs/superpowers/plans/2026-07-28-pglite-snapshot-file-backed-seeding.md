# PGLite Snapshot Seeding for Fresh File-Backed dataDirs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a fresh, empty, **file-backed** PGLite dataDir be seeded from the existing snapshot tar — skipping WASM `initdb`, the schema blob, and all 119 migrations — behind a test-only opt-in flag.

**Architecture:** Two pure helpers (`snapshotEligible`, `resolveSnapshotPath`) land in a new focused module and are unit-tested without touching PGLite. `PGLiteEngine.connect()` then consults them instead of its current `!dataDir` guard, and gains a narrow catch-and-retry for the one case where PGLite throws instead of falling back. The existing staleness guard is preserved verbatim.

**Tech Stack:** TypeScript, Bun test runner, `@electric-sql/pglite` 0.4.3.

**Design spec:** `docs/superpowers/specs/2026-07-28-pglite-snapshot-file-backed-seeding-design.md`

## Global Constraints

- **Filesystem paths: never `new URL(...).pathname`.** On Windows it yields `/C:/Users/...`, which no Win32 API accepts. Use `fileURLToPath()` from `node:url`. This is a repo-wide invariant in `CLAUDE.md` and it is an identity transform on POSIX, so Linux CI can never catch a violation.
- **Capturing test output: never pipe through `tail` or `head`.** Redirect to a file first, then read the file. After a pipe, `$?` is `tail`'s exit code (always 0), so failures silently pass. Every run command below follows this.
- **This change is PGLite-only and adds no `BrainEngine` method.** The engine-parity invariant (`postgres-engine.ts` and `pglite-engine.ts` move in lockstep, pinned by `test/e2e/engine-parity.test.ts`) is **not** engaged: Postgres has no WASM `initdb` to skip. Do not add a mirrored Postgres method.
- **Scope is test-only.** Real user brains must never seed from a snapshot. The `GBRAIN_PGLITE_SNAPSHOT_SEED_FILE` flag is the only way to enable the file-backed path, and nothing in `src/` may set it.
- **The staleness guard is preserved exactly.** `tryLoadSnapshot` keeps comparing the sidecar `.version` against the current `MIGRATIONS` + schema hash and returning `null` on mismatch. A stale snapshot restoring an out-of-date schema is worse than a slow boot.
- **The flag value must be exactly the string `'1'`.** Not "truthy" — an accidental `GBRAIN_PGLITE_SNAPSHOT_SEED_FILE=0` must not enable seeding.

## File Structure

| File | Responsibility |
|---|---|
| `src/core/pglite-snapshot.ts` | **Create.** The two pure decision helpers. No PGLite import, so it unit-tests in milliseconds. |
| `src/core/pglite-engine.ts` | **Modify.** Export `tryLoadSnapshot` for testing; reset `_snapshotLoaded`; consult the helpers; extract the init-error wrapper; add the narrow retry. |
| `test/pglite-snapshot-eligibility.test.ts` | **Create.** Truth table for both helpers + staleness cases for `tryLoadSnapshot`. Fast, no PGLite. |
| `test/pglite-snapshot-file-seeding.serial.test.ts` | **Create.** The equivalence test — seeded and cold-init dataDirs must reach the same migration head. Slow, serial, skips without a fixture. |
| `scripts/bench-pglite-bootstrap.ts` | **Create.** A/B benchmark harness that records concurrent-process count per rep. |

The two decision helpers go in their own module rather than into `pglite-engine.ts` (already ~7k lines) so they can be tested without booting a WASM Postgres. That is the difference between a 5ms test and a 110s one.

---

### Task 1: Pure decision helpers

**Files:**
- Create: `src/core/pglite-snapshot.ts`
- Test: `test/pglite-snapshot-eligibility.test.ts`

**Interfaces:**
- Consumes: `findRepoRoot` from `src/core/repo-root.ts` (signature: `findRepoRoot(startDir?: string): string | null`).
- Produces:
  - `snapshotEligible(dataDir: string | undefined, env?: NodeJS.ProcessEnv, fsExists?: (p: string) => boolean): boolean`
  - `resolveSnapshotPath(raw: string, moduleDir?: string, cwd?: string): string`

Both take their environment as injected parameters so the tests need no global mutation.

- [ ] **Step 1: Write the failing test**

Create `test/pglite-snapshot-eligibility.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotEligible, resolveSnapshotPath } from '../src/core/pglite-snapshot.ts';
import { REPO_ROOT } from './helpers/repo-root.ts';

const never = () => false;
const always = () => true;

describe('snapshotEligible', () => {
  test('in-memory (no dataDir) stays eligible regardless of the seed flag', () => {
    expect(snapshotEligible(undefined, {}, never)).toBe(true);
    expect(snapshotEligible(undefined, { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '1' }, never)).toBe(true);
  });

  test('file-backed WITHOUT the seed flag is not eligible', () => {
    expect(snapshotEligible('/tmp/brain.pglite', {}, never)).toBe(false);
  });

  test('file-backed WITH the flag and an empty dataDir is eligible', () => {
    expect(
      snapshotEligible('/tmp/brain.pglite', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '1' }, never),
    ).toBe(true);
  });

  test('file-backed WITH the flag but an existing cluster is not eligible', () => {
    expect(
      snapshotEligible('/tmp/brain.pglite', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '1' }, always),
    ).toBe(false);
  });

  test('the flag must be exactly "1"', () => {
    expect(snapshotEligible('/tmp/b', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: 'true' }, never)).toBe(false);
    expect(snapshotEligible('/tmp/b', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '0' }, never)).toBe(false);
    expect(snapshotEligible('/tmp/b', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '' }, never)).toBe(false);
  });

  test('emptiness is decided by PG_VERSION at the dataDir root', () => {
    const seen: string[] = [];
    snapshotEligible('/tmp/brain.pglite', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '1' }, (p) => {
      seen.push(p);
      return false;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].replace(/\\/g, '/')).toBe('/tmp/brain.pglite/PG_VERSION');
  });
});

describe('resolveSnapshotPath', () => {
  test('absolute paths pass through unchanged', () => {
    const abs = process.platform === 'win32' ? 'C:\\snap\\x.tar' : '/snap/x.tar';
    expect(resolveSnapshotPath(abs)).toBe(abs);
  });

  test('a relative path becomes absolute', () => {
    const out = resolveSnapshotPath('test/fixtures/pglite-snapshot.tar');
    expect(isAbsolute(out)).toBe(true);
    expect(out).toContain('pglite-snapshot.tar');
  });

  // The finding this guards: the env var holds a RELATIVE path, so a test that
  // spawns the CLI from a tmpdir cwd would silently miss the snapshot and fall
  // back to a slow boot — reporting "no win" for an unrelated reason.
  test('a relative path resolves identically from an unrelated cwd', () => {
    const fromRepo = resolveSnapshotPath('test/fixtures/pglite-snapshot.tar', undefined, REPO_ROOT);
    const fromTmp = resolveSnapshotPath('test/fixtures/pglite-snapshot.tar', undefined, tmpdir());
    expect(fromRepo).toBe(fromTmp);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test test/pglite-snapshot-eligibility.test.ts > /tmp/t1.txt 2>&1; echo "EXIT=$?"; cat /tmp/t1.txt
```

Expected: FAIL — `Cannot find module '../src/core/pglite-snapshot.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/pglite-snapshot.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test test/pglite-snapshot-eligibility.test.ts > /tmp/t1.txt 2>&1; echo "EXIT=$?"; cat /tmp/t1.txt
```

Expected: PASS, 9 tests, `EXIT=0`.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck > /tmp/tc1.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/tc1.txt
```

Expected: `EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add src/core/pglite-snapshot.ts test/pglite-snapshot-eligibility.test.ts
git commit -m "feat(pglite): snapshot eligibility + path-resolution helpers"
```

---

### Task 2: Export `tryLoadSnapshot` and pin the staleness guard

The staleness guard is the safety-critical half of this feature, and it is currently untestable because `tryLoadSnapshot` is module-private. Exporting it buys cheap coverage of the exact behaviour that must not regress.

**Files:**
- Modify: `src/core/pglite-engine.ts:85` (add `export`)
- Test: `test/pglite-snapshot-eligibility.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `tryLoadSnapshot(snapshotPath: string): Blob | null` becomes an exported symbol. Behaviour unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/pglite-snapshot-eligibility.test.ts`:

```ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { tryLoadSnapshot } from '../src/core/pglite-engine.ts';

describe('tryLoadSnapshot staleness guard', () => {
  // A stale snapshot restoring an out-of-date schema is far worse than a slow
  // boot, so every one of these MUST return null rather than a Blob, and MUST
  // NOT throw — the engine treats the snapshot as an optimization, never as
  // authoritative.
  test('missing tar returns null', () => {
    expect(tryLoadSnapshot('/definitely/not/here/snap.tar')).toBeNull();
  });

  test('tar present but .version sidecar missing returns null', () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'snap-stale-'));
    try {
      const tar = joinPath(dir, 'snap.tar');
      writeFileSync(tar, 'not-a-real-tar');
      expect(tryLoadSnapshot(tar)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('hash mismatch in .version returns null', () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'snap-stale-'));
    try {
      const tar = joinPath(dir, 'snap.tar');
      writeFileSync(tar, 'not-a-real-tar');
      writeFileSync(joinPath(dir, 'snap.version'), 'deadbeef-not-the-current-hash\n');
      expect(tryLoadSnapshot(tar)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test test/pglite-snapshot-eligibility.test.ts > /tmp/t2.txt 2>&1; echo "EXIT=$?"; cat /tmp/t2.txt
```

Expected: FAIL — `tryLoadSnapshot` is not an export of `pglite-engine.ts`.

- [ ] **Step 3: Add the export**

In `src/core/pglite-engine.ts`, change line 85 from:

```ts
function tryLoadSnapshot(snapshotPath: string): Blob | null {
```

to:

```ts
// Exported for test: the staleness guard is safety-critical (a stale snapshot
// would restore an out-of-date schema) and cannot be pinned while private.
export function tryLoadSnapshot(snapshotPath: string): Blob | null {
```

Change nothing else in the function body.

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test test/pglite-snapshot-eligibility.test.ts > /tmp/t2.txt 2>&1; echo "EXIT=$?"; cat /tmp/t2.txt
```

Expected: PASS, 12 tests, `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/pglite-engine.ts test/pglite-snapshot-eligibility.test.ts
git commit -m "test(pglite): pin the snapshot staleness guard"
```

---

### Task 3: Wire the helpers into `connect()`

**Files:**
- Modify: `src/core/pglite-engine.ts` — the `connect()` method (currently ~291-348, but Step 1 shifts these; anchor by content)

**Interfaces:**
- Consumes: `snapshotEligible`, `resolveSnapshotPath` from Task 1.
- Produces: no new public surface. `connect()` behaviour for in-memory brains is unchanged.

- [ ] **Step 1: Add the import**

At the top of `src/core/pglite-engine.ts`, alongside the other `./` imports (near line 33's `pglite-lock.ts` import):

```ts
import { snapshotEligible, resolveSnapshotPath } from './pglite-snapshot.ts';
```

- [ ] **Step 2: Extract the init-error wrapper**

The retry needs the existing classification path in two places. Add this private method to `PGLiteEngine`, immediately after `connect()`:

```ts
  /**
   * Wrap a `PGlite.create()` failure into the actionable message and release
   * the lock. Extracted so the snapshot retry can reuse it without duplicating
   * the lock-release — leaking the lock turns a recoverable init error into a
   * stuck-brain state.
   */
  private async _wrapAndReleaseInitError(err: unknown): Promise<Error> {
    const original = stringifyPgliteInitError(err); // #2674
    const verdict = classifyPgliteInitError(original);
    const wrapped = new Error(buildPgliteInitErrorMessage(verdict, original));
    if (this._lock?.acquired) {
      try { await releaseLock(this._lock); } catch { /* ignore cleanup error */ }
      this._lock = null;
    }
    return wrapped;
  }
```

- [ ] **Step 3: Replace the snapshot gate and the create/catch block**

Anchor by content, **not** by line number — Step 1 added an import, so every line
below it has already shifted. Replace the contiguous block that starts at the
comment line:

```ts
    // Tier 3: optional snapshot fast-restore. Only applies to in-memory
```

and ends with the closing brace of the `catch (err) { ... }` that wraps
`PGlite.create()` (the last statement before `connect()`'s own closing brace —
its final lines are `      throw wrapped;` then `    }`). Replace that whole
block with:

```ts
    // Tier 3: optional snapshot fast-restore. In-memory brains have always
    // been eligible. A FILE-BACKED dataDir is eligible only behind
    // GBRAIN_PGLITE_SNAPSHOT_SEED_FILE=1 and only while it holds no cluster
    // yet — see snapshotEligible(). Mismatched or missing snapshot files
    // silently fall back to a normal init; the snapshot is an optimization,
    // never authoritative.
    this._snapshotLoaded = false; // reset: a file-backed reconnect() re-opens
    let loadDataDir: Blob | undefined;
    if (process.env.GBRAIN_PGLITE_SNAPSHOT && snapshotEligible(dataDir)) {
      const snapshotResult = tryLoadSnapshot(
        resolveSnapshotPath(process.env.GBRAIN_PGLITE_SNAPSHOT),
      );
      if (snapshotResult) {
        loadDataDir = snapshotResult;
        this._snapshotLoaded = true;
      }
    }

    // NOTE (#2084): PGLite's Emscripten runtime writes the WASM backend's
    // proc_exit status into `process.exitCode` (initdb here at create-time,
    // the postmaster at close-time), and the writes land asynchronously —
    // a snapshot/restore around these awaits does NOT contain them. That is
    // why the CLI's exit paths read gbrain's own verdict
    // (cli-force-exit.ts currentExitCode), never ambient process.exitCode.
    try {
      this._db = await preservingProcessExitCode(() =>
        PGlite.create({
          dataDir,
          loadDataDir,
          extensions: { vector, pg_trgm },
        }),
      );
    } catch (err) {
      // Narrow retry, on all three conditions: we passed a snapshot, AND
      // PGLite refused because the dataDir already holds a cluster. That is
      // the TOCTOU window between snapshotEligible()'s emptiness check and
      // this open. Without the retry, a race turns a slow boot into a crash.
      //
      // Every OTHER failure — and any failure of the retry itself — falls
      // through to the classification path, which produces the actionable
      // bunfs / macos-26-3 / corrupt hint. A broad catch here would swallow
      // genuine init failures and regress that diagnostic surface.
      const original = stringifyPgliteInitError(err);
      const raced = loadDataDir !== undefined
        && /Database already exists, cannot load from tarball/i.test(original);
      if (!raced) {
        throw await this._wrapAndReleaseInitError(err);
      }
      loadDataDir = undefined;
      this._snapshotLoaded = false;
      try {
        this._db = await preservingProcessExitCode(() =>
          PGlite.create({
            dataDir,
            extensions: { vector, pg_trgm },
          }),
        );
      } catch (retryErr) {
        throw await this._wrapAndReleaseInitError(retryErr);
      }
    }
```

- [ ] **Step 4: Verify the in-memory path did not change**

```bash
bun test test/bootstrap.test.ts test/schema-bootstrap-coverage.test.ts > /tmp/t3.txt 2>&1; echo "EXIT=$?"; cat /tmp/t3.txt
```

Expected: `EXIT=0`. These files `delete process.env.GBRAIN_PGLITE_SNAPSHOT` so they exercise cold init; they must be unaffected.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck > /tmp/tc3.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/tc3.txt
```

Expected: `EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add src/core/pglite-engine.ts
git commit -m "feat(pglite): seed fresh file-backed dataDirs from snapshot behind an opt-in"
```

---

### Task 4: Equivalence test — seeded and cold-init must agree

This is the safety net for the whole feature. Without it, the change is unfalsifiable: a snapshot that seeds a subtly different schema would look like a pure speedup.

**Files:**
- Create: `test/pglite-snapshot-file-seeding.serial.test.ts`

**Interfaces:**
- Consumes: `PGLiteEngine` from `src/core/pglite-engine.ts`; `REPO_ROOT`/`repoPath` from `test/helpers/repo-root.ts`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

```ts
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
  const r = await engine.db.query<{ v: number | null }>(
    'SELECT MAX(version)::int AS v FROM schema_migrations',
  );
  return r.rows[0]?.v ?? -1;
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
  test('seeded dataDir reaches the same migration head as cold init', async () => {
    const seeded = await headUnder(freshDataDir(), SEEDED);
    const cold = await headUnder(freshDataDir(), COLD);
    expect(seeded).toBeGreaterThan(0);
    expect(seeded).toBe(cold);
  }, 900_000);

  test('seeding is skipped when the opt-in flag is absent', async () => {
    expect(await headUnder(freshDataDir(), BASE_ONLY)).toBeGreaterThan(0);
  }, 900_000);
});
```

- [ ] **Step 2: Build the fixture if absent**

```bash
bun run build:pglite-snapshot > /tmp/snap.txt 2>&1; echo "EXIT=$?"; cat /tmp/snap.txt
```

Expected: `EXIT=0`, writes `test/fixtures/pglite-snapshot.tar` + `.version`. Takes ~90s+ on Windows.

- [ ] **Step 3: Run the test**

```bash
bun test test/pglite-snapshot-file-seeding.serial.test.ts --max-concurrency=1 > /tmp/t4.txt 2>&1; echo "EXIT=$?"; cat /tmp/t4.txt
```

Expected: PASS, 2 tests, `EXIT=0`. If it reports 0 tests, the fixture is missing — re-run Step 2.

**If `seeded !== cold`, STOP.** That means the snapshot does not faithfully reproduce a cold-init schema, and the feature must not ship. Report the two head values rather than adjusting the assertion.

- [ ] **Step 4: Commit**

```bash
git add test/pglite-snapshot-file-seeding.serial.test.ts
git commit -m "test(pglite): pin seeded/cold-init schema equivalence"
```

---

### Task 5: Benchmark and the ship/abandon decision

The spec makes the benchmark, not the estimate, the ship gate.

**Files:**
- Create: `scripts/bench-pglite-bootstrap.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime; exercises the CLI end to end.
- Produces: nothing.

- [ ] **Step 1: Write the harness**

```ts
#!/usr/bin/env bun
/**
 * A/B benchmark: `gbrain init --migrate-only` against a fresh file-backed
 * brain, with and without snapshot seeding.
 *
 * Arms ALTERNATE rather than running in blocks: this box's contention spread
 * is ~2.5x (two back-to-back reps of one spawn measured 11.3s and 28.9s), so
 * running all of arm A then all of arm B would confound the arm with the load
 * at the time. The concurrent `bun` count is recorded per rep for the same
 * reason — a timing without it is uninterpretable.
 *
 * Run: bun run scripts/bench-pglite-bootstrap.ts [reps]
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(REPO, 'test', 'fixtures', 'pglite-snapshot.tar');
const REPS = Number(process.argv[2] ?? 3);

async function bunProcCount(): Promise<number> {
  try {
    const p = Bun.spawn(
      ['powershell', '-NoProfile', '-Command',
       '(Get-Process bun -ErrorAction SilentlyContinue | Measure-Object).Count'],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    return Number((await new Response(p.stdout).text()).trim()) || 0;
  } catch {
    return -1;
  }
}

async function oneRep(seed: boolean): Promise<{ ms: number; procs: number; ok: boolean }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-bench-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, '.gbrain', 'brain.pglite'),
      embedding_dimensions: 1536,
    }) + '\n',
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    GBRAIN_HOME: home,
  };
  if (seed) {
    env.GBRAIN_PGLITE_SNAPSHOT = SNAPSHOT;
    env.GBRAIN_PGLITE_SNAPSHOT_SEED_FILE = '1';
  } else {
    delete env.GBRAIN_PGLITE_SNAPSHOT;
    delete env.GBRAIN_PGLITE_SNAPSHOT_SEED_FILE;
  }
  const procs = await bunProcCount();
  const t0 = Date.now();
  const proc = Bun.spawn(['bun', 'run', join(REPO, 'src', 'cli.ts'), 'init', '--migrate-only'], {
    cwd: REPO, env, stdout: 'pipe', stderr: 'pipe',
  });
  const [, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ms = Date.now() - t0;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  return { ms, procs, ok: code === 0 };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

if (!existsSync(SNAPSHOT)) {
  console.error(`missing ${SNAPSHOT} — run: bun run build:pglite-snapshot`);
  process.exit(1);
}

const cold: number[] = [];
const seeded: number[] = [];
for (let i = 0; i < REPS; i++) {
  for (const seed of [false, true]) {
    const r = await oneRep(seed);
    (seed ? seeded : cold).push(r.ms);
    console.log(
      `rep ${i + 1} ${seed ? 'SEEDED' : 'cold  '}: ${r.ms}ms  bun_procs=${r.procs}  exit_ok=${r.ok}`,
    );
  }
}
console.log(`\ncold   n=${cold.length} median=${median(cold)}ms  min=${Math.min(...cold)} max=${Math.max(...cold)}`);
console.log(`seeded n=${seeded.length} median=${median(seeded)}ms  min=${Math.min(...seeded)} max=${Math.max(...seeded)}`);
console.log(`speedup (median): ${(median(cold) / median(seeded)).toFixed(2)}x`);
```

- [ ] **Step 2: Run the benchmark**

```bash
bun run scripts/bench-pglite-bootstrap.ts 3 > /tmp/bench.txt 2>&1; echo "EXIT=$?"; cat /tmp/bench.txt
```

Expected: `EXIT=0`, 6 reps, every `exit_ok=true`.

- [ ] **Step 3: Apply the decision gate**

From the spec:

- Median seeded **~30-40s** (≈3x): the feature delivers. Proceed to Step 4.
- Median seeded **~80s or worse** (<1.5x): **abandon.** Revert Tasks 1-4 and record the measured numbers in the spec's Open-question section. The ~40 MB untar-and-write-through was the dominant cost, and the added branch is not worth its risk.
- Anything between: report the numbers and ask before proceeding. Do not decide unilaterally.

If any `exit_ok=false`, the benchmark is invalid — fix the failure before reading the timings.

- [ ] **Step 4: Record the result in the spec**

Replace the spec's "Open question this design does not settle" section with the measured medians, the per-rep `bun_procs` range, and the verdict.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench-pglite-bootstrap.ts docs/superpowers/specs/2026-07-28-pglite-snapshot-file-backed-seeding-design.md
git commit -m "bench(pglite): A/B snapshot-seeding harness and measured result"
```

---

## Notes for the implementer

- **Do not enable the flag in `scripts/ci-local.sh`.** It exports `GBRAIN_PGLITE_SNAPSHOT` across all 4 unit shards; adding the seed flag there would switch every file-backed test at once, which is exactly the blast radius option B was chosen to avoid. Opting a specific test file in is a separate, deliberate change.
- **`test/helpers/pglite-spawn-budget.ts` does not exist on this branch.** It lives on `claude/agitated-davinci-5876bb`. Do not import it, and do not try to shrink budgets that aren't here.
- `EngineConfig` (`src/core/types.ts:1654`) is `{ database_url?, database_path?, engine? }` — every field optional — so `engine.connect({ database_path })` typechecks with no cast. Do not add one.
