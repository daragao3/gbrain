# Windows Test Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the unique bounded Windows unit-runner behavior from commit `8719634599c35ba0a63834a2f0422fa192629793` onto a pinned master baseline, retain portability work already integrated there, and implement the remaining shell, IPC, symlink-fixture, subprocess, teardown, supervisor, and stalled-chunk fixes without running the complete suite.

**Architecture:** Integrate semantically rather than cherry-picking the stale branch. Keep native-path and CRLF logic centralized, isolate platform shell resolution and resolve-IPC endpoint generation behind narrow typed interfaces, and make tests acquire and release only owned resources. Diagnose the four stalled chunks with bounded file-level and evidence-driven pair runs; do not infer a common root merely from chunk membership.

**Tech Stack:** Bun, TypeScript, Node-compatible `child_process` and `net`, Git, Bash, Windows named pipes, PGlite-backed unit tests.

## Global Constraints

- Use pinned master commit `479eedf09efbfd5092f1044cf5866969ab362777` as the integration baseline unless an explicit refresh step records and substitutes a newer exact SHA before any edit; never use a moving branch name as the implementation base.
- Preserve branch reference `claude/determined-mccarthy-8d896b` and unique commit `8719634599c35ba0a63834a2f0422fa192629793` before changing history.
- Do not blindly merge or cherry-pick the complete stale commit; reconstruct its runner semantics where master conflicts.
- Do not run `bun run test`, `bun run test:full`, `bun run ci:local`, the entire `test/scripts/` directory, or any complete-suite equivalent.
- Do not revisit or expand the disputed dynamic-import theory.
- Do not kill unrelated processes. Any termination must be restricted to a child/process tree created by the current test or handler invocation.
- Preserve fail-closed `OperationContext.remote` behavior, `sourceScopeOpts(ctx)` source isolation, realpath-backed symlink confinement, the `GBRAIN_ALLOW_SHELL_JOBS=1` protected-job gate, and direct `argv` execution without a shell.
- Do not log or persist inherited secret values.
- Capture complete output before inspection. Every test/check command below redirects stdout and stderr to a unique session-owned file and records the command's own exit code before reading that file.
- Use `C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/` for command logs. Create it once with `mkdir -p`; do not reuse generic `/tmp` filenames shared with sibling sessions.
- A `bun test` command must use explicit files or an exact `-t` filter and `--timeout=60000` or a larger documented bound.
- Do not commit, push, open a PR, release, or ship. This plan intentionally omits those steps.
- Do not claim the complete Windows suite is green. Completion means the focused gates in this plan pass or remaining failures are reported from their full logs.

## File and responsibility map

### New files

- `src/core/minions/handlers/shell-platform.ts` — resolves a command string into the platform shell executable and argument vector; contains no policy gate or environment construction.
- `test/shell-platform.test.ts` — platform-independent contract tests for POSIX and Windows shell resolution using an injected platform/environment.
- `test/helpers/fs-capabilities.ts` — cached, exact filesystem capability probes for file symlinks, directory symlinks, directory junctions, and Git mode-`120000` checkout semantics.
- `test/fixtures/transcript-worker.mjs` — portable child fixture with `stdout`, `exit`, and `wait` modes for transcript-capture tests.

### Files reconciled from the stale runner commit

- `scripts/run-unit-parallel.sh` — runtime platform detection, one-shard Windows default, file-count-scaled shard timeout, outer progress watchdog, natural-completion marker, and owned-tree termination.
- `scripts/run-unit-shard.sh` — four-file Windows chunks, per-chunk timeout, rc 124/127 diagnostics, aggregate summaries, and completion marker.
- `test/scripts/run-unit-parallel.test.ts` — focused runner contract regressions.
- `test/scripts/run-unit-shard.test.ts` — focused chunking, timeout, crash, completion, and exclusion regressions.
- `docs/TESTING.md` — current-state documentation for the retained runner contract; update rather than append release-history prose.
- `TODOS.md` — retain only still-open follow-up items; do not copy stale completed or version-specific narration.

### Existing source files modified

- `src/core/minions/handlers/shell.ts` — consumes the platform resolver, preserves direct `argv`, and delegates owned-process termination to a platform-aware helper.
- `src/core/claw-test/transcript-capture.ts` — settle timeout/spawn paths exactly once and terminate only the owned child tree.
- `src/core/context/resolve-ipc.ts` — explicit `ResolveIpcEndpoint`, deterministic named-pipe generation, endpoint-aware client/server behavior, accepted-socket tracking, and awaited closure.
- `src/core/context/reflex.ts` — passes the explicit endpoint to the IPC client.
- `src/mcp/server.ts` — stores the endpoint/managed server and performs ordered asynchronous shutdown.
- `src/commands/doctor.ts` — reports Unix socket visibility and Windows named-pipe configuration without treating a pipe as a filesystem path.
- `src/core/minions/child-worker-supervisor.ts` — settle-once spawn failure across `error`, `exit`, and `close`.
- `src/core/brain-repo-durability.ts` — suppress the newly installed post-commit hook during the scaffolding commit with `core.hooksPath=/dev/null`.

### Existing tests modified

- `test/minions-shell.test.ts` — native temp cwd, portable command/argv fixtures, platform-aware environment syntax, owned cancellation, and portable audit failure target.
- `test/transcript-capture.test.ts` — `process.execPath` plus `.mjs` fixture instead of `/bin/sh`.
- `test/context/resolve-ipc.test.ts` — endpoint contract, named-pipe round trip, Unix-only artifact assertions, and awaited teardown.
- `test/retrieval-reflex.test.ts` — explicit endpoint consumer and fail-soft behavior.
- `test/child-worker-supervisor.test.ts` — portable `.mjs`/platform-shell harness, failed-spawn regression, and two-stage bounded hang net.
- `test/supervisor.test.ts` — semantic `.cmd`/`.sh` fixtures, native PID paths, Windows startup floors, and POSIX-only graceful-SIGTERM assertions.
- `test/code-callers-pin.serial.test.ts` — restore cwd before recursive deletion in all nine affected cases.
- `test/brain-repo-durability.serial.test.ts` — observable push quiescence, hook-suppression regression, mode-bit platform gates, and failure-preserving cleanup.
- Symlink fixture files listed in Task 7 — use exact capability gates rather than unconditional `symlinkSync()`.

### Existing files verified, not recreated

- `src/core/path-confine.ts` and its callers — retain `path.relative()`/`path.isAbsolute()` lexical containment and realpath-backed confinement from master.
- `test/path-boundary.test.ts`, `test/check-path-sep-boundary.test.ts`, `scripts/check-path-sep-boundary.sh` — retain native-boundary tests and guard.
- `test/skills-conformance.test.ts`, `test/resolver.test.ts`, `scripts/check-frontmatter-fence.sh`, `test/check-frontmatter-fence.test.ts` — retain normalize-once CRLF parsing and static guard.
- `test/no-tracked-symlinks-guard.test.ts` — retain the repository policy guard; do not confuse it with runtime fixture capability.

---

### Task 1: Pin the integration baseline and inventory semantic deltas

**Files:**
- Inspect: repository refs and working tree
- Inspect: `scripts/run-unit-parallel.sh`
- Inspect: `scripts/run-unit-shard.sh`
- Inspect: `test/scripts/run-unit-parallel.test.ts`
- Inspect: `test/scripts/run-unit-shard.test.ts`
- Inspect: `docs/TESTING.md`
- Inspect: `TODOS.md`

**Interfaces:**
- Consumes: exact stale commit `8719634599c35ba0a63834a2f0422fa192629793`; preferred pinned baseline `479eedf09efbfd5092f1044cf5866969ab362777`.
- Produces: a recorded base SHA, preserved branch ref, and path-by-path reconciliation checklist. No source edit occurs in this task.

- [ ] **Step 1: Record branch, HEAD, baseline, and status before touching history**

```bash
mkdir -p C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729 && {
  printf 'branch='; git branch --show-current
  printf 'head='; git rev-parse HEAD
  printf 'master='; git rev-parse master
  printf 'pinned='; git rev-parse 479eedf09efbfd5092f1044cf5866969ab362777
  git status --short
} > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/01-baseline.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/01-baseline.txt; exit "$rc"
```

Expected: `EXIT=0`; branch is `claude/determined-mccarthy-8d896b`; HEAD is `8719634599c35ba0a63834a2f0422fa192629793`; `docs/superpowers/` is the only untracked area. If master has moved, keep `479eedf...` as this approved plan's base unless the implementer explicitly records a replacement exact SHA and recomputes every comparison below.

- [ ] **Step 2: Preserve the stale branch reference without changing commits**

```bash
git branch windows-portability-runner-87196345 8719634599c35ba0a63834a2f0422fa192629793 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/02-preserve-ref.txt 2>&1; rc=$?; git show-ref --verify refs/heads/windows-portability-runner-87196345 >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/02-preserve-ref.txt 2>&1; show_rc=$?; printf 'BRANCH_EXIT=%s SHOW_EXIT=%s\n' "$rc" "$show_rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/02-preserve-ref.txt; test "$show_rc" -eq 0
```

Expected: preserved ref resolves to `87196345...`. If it already exists at that SHA, treat that as success; do not force-move a contradictory existing ref.

- [ ] **Step 3: Produce the exact three-dot and patch-identity evidence**

```bash
{
  git merge-base 8719634599c35ba0a63834a2f0422fa192629793 479eedf09efbfd5092f1044cf5866969ab362777
  git rev-list --left-right --count 8719634599c35ba0a63834a2f0422fa192629793...479eedf09efbfd5092f1044cf5866969ab362777
  git diff --stat 479eedf09efbfd5092f1044cf5866969ab362777...8719634599c35ba0a63834a2f0422fa192629793
  git cherry 479eedf09efbfd5092f1044cf5866969ab362777 8719634599c35ba0a63834a2f0422fa192629793
} > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/03-patch-identity.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/03-patch-identity.txt; exit "$rc"
```

Expected: `EXIT=0`; `git cherry` reports `+ 87196345...`, proving the patch remains semantically unique relative to the pinned base.

- [ ] **Step 4: Preview conflicts without changing the worktree**

```bash
git merge-tree --write-tree 479eedf09efbfd5092f1044cf5866969ab362777 8719634599c35ba0a63834a2f0422fa192629793 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/04-merge-tree.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/04-merge-tree.txt; test "$rc" -eq 1
```

Expected: controlled `EXIT=1` with content conflicts in `docs/TESTING.md`, `scripts/run-unit-parallel.sh`, and `test/scripts/run-unit-parallel.test.ts`; no worktree mutation.

- [ ] **Step 5: Move the current branch to the pinned integration base only after confirming no implementation edits exist**

Use Git commands appropriate to the current branch policy, but the resulting branch must point at `479eedf09efbfd5092f1044cf5866969ab362777` while the untracked approved spec/plan remain available. Do not use `git reset --hard`; it is destructive. If the worktree has source/test edits, stop and reconcile them rather than discarding them.

Verification:

```bash
{
  git rev-parse HEAD
  git status --short
  git show-ref --verify refs/heads/windows-portability-runner-87196345
} > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/05-integration-base.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/05-integration-base.txt; exit "$rc"
```

Expected: HEAD is the recorded pinned base; the preserved ref is still `87196345...`; only approved untracked docs exist.

### Task 2: Reconcile the bounded Windows unit runner

**Files:**
- Modify: `scripts/run-unit-parallel.sh`
- Modify: `scripts/run-unit-shard.sh`
- Modify: `test/scripts/run-unit-parallel.test.ts`
- Modify: `test/scripts/run-unit-shard.test.ts`
- Modify: `docs/TESTING.md`
- Inspect/update only if still applicable: `TODOS.md`

**Interfaces:**
- Consumes: Bash runner contract from `87196345`; master-side script and test changes.
- Produces: `GBRAIN_TEST_CHUNK_SIZE`, `GBRAIN_TEST_CHUNK_TIMEOUT`, `GBRAIN_TEST_SHARD_TIMEOUT`, `GBRAIN_TEST_SHARD_STALL_SECONDS`, and `GBRAIN_TEST_SHARD_COMPLETED_FILE` behavior documented and tested.

- [ ] **Step 1: Add or reconcile failing runner tests before changing scripts**

Retain exact assertions for:

```ts
expect(windowsDefaultShards).toBe(1);
expect(windowsDefaultChunkSize).toBe(4);
expect(windowsDefaultChunkTimeout).toBe(300);
expect(derivedShardTimeout).toBe(Math.max(discoveredFileCount * 30, 1500));
expect(existsSync(completedMarker)).toBe(true);
expect(timeoutResult.stderr).toContain('CHUNK 1 STALLED after 1s');
expect(crashResult.stderr).toContain('CHUNK 1 CRASHED (rc=127');
```

The parallel tests must also assert that an inner rc 124 chunk diagnosis is not rewritten as an outer whole-shard wedge and that termination targets only the test-owned child tree.

- [ ] **Step 2: Run only the runner tests to establish the expected red state on the pinned base**

```bash
bun test test/scripts/run-unit-parallel.test.ts test/scripts/run-unit-shard.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/06-runner-red.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/06-runner-red.txt; exit "$rc"
```

Expected before implementation: nonzero exit with missing Windows defaults/watchdog/completion-marker assertions, not a test harness timeout. If master already carries one assertion, keep it and identify the remaining red assertions rather than weakening tests.

- [ ] **Step 3: Reconstruct runtime platform and chunk defaults in `scripts/run-unit-shard.sh`**

Implement the exact decision shape:

```bash
bun_platform="$(bun -e 'process.stdout.write(process.platform)' 2>/dev/null || true)"
case "$bun_platform:$(uname -s 2>/dev/null)" in
  win32:*|*:MINGW*|*:MSYS*|*:CYGWIN*)
    default_chunk=4
    default_chunk_timeout=300
    ;;
  *)
    default_chunk=0
    default_chunk_timeout=0
    ;;
esac
```

Validate both overrides as bounded non-negative Bash integers before arithmetic. Group selected test paths into `GBRAIN_TEST_CHUNK_SIZE` batches, wrap positive timeouts with `timeout`/`gtimeout`, aggregate each Bun summary, name every file in rc 124/127 diagnostics, and touch `GBRAIN_TEST_SHARD_COMPLETED_FILE` only after natural completion.

- [ ] **Step 4: Reconstruct one-shard Windows and outer watchdog semantics in `scripts/run-unit-parallel.sh`**

Use Bun runtime detection before `uname` fallback. For default Windows runs derive:

```bash
TOTAL_UNIT_FILES="$(SHARD= bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null | wc -l | tr -d ' ')"
SHARD_TIMEOUT=$((TOTAL_UNIT_FILES * 30))
[ "$SHARD_TIMEOUT" -lt 1500 ] && SHARD_TIMEOUT=1500
```

Keep explicit `SHARDS`, `--shards`, and `GBRAIN_TEST_SHARD_TIMEOUT` overrides authoritative. Add a default 600-second no-log-growth watchdog controlled by `GBRAIN_TEST_SHARD_STALL_SECONDS`. Let the natural-completion marker win races with timeout sentinels. On Windows call `taskkill.exe /PID <owned-shell-pid> /T /F` only after proving that PID came from the wrapper's own spawn; on POSIX retain recursive owned-descendant termination.

- [ ] **Step 5: Run focused runner tests to green**

```bash
bun test test/scripts/run-unit-parallel.test.ts test/scripts/run-unit-shard.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/07-runner-green.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/07-runner-green.txt; exit "$rc"
```

Expected: `EXIT=0`; all runner tests pass; no full unit suite starts.

- [ ] **Step 6: Update `docs/TESTING.md` as current-state documentation**

Document one Windows shard, four files per Bun process, 300-second chunk cap, file-count-scaled outer cap with 1,500-second floor, 600-second no-log watchdog, completion marker, and rc 124/127 diagnostics. Do not append version-history clauses. Leave `TODOS.md` unchanged unless a still-open item must be adjusted to match current truth.

- [ ] **Step 7: Prove the reconstructed behavior is still semantically present**

```bash
{
  git diff -- scripts/run-unit-parallel.sh scripts/run-unit-shard.sh test/scripts/run-unit-parallel.test.ts test/scripts/run-unit-shard.test.ts docs/TESTING.md TODOS.md
  git diff 8719634599c35ba0a63834a2f0422fa192629793 -- scripts/run-unit-parallel.sh scripts/run-unit-shard.sh test/scripts/run-unit-parallel.test.ts test/scripts/run-unit-shard.test.ts
} > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/08-runner-semantic-diff.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/08-runner-semantic-diff.txt; exit "$rc"
```

Expected: intentional master-side differences may remain, but every named contract is visible in source/tests. No reverted master behavior appears.

### Task 3: Verify already-integrated containment and CRLF work

**Files:**
- Verify: `src/core/path-confine.ts`
- Verify callers: `src/core/storage/local.ts`, `src/core/file-resolver.ts`, `src/core/brain-writer.ts`, `src/core/skillpack/copy.ts`, `src/core/source-resolver.ts`, `src/commands/sync.ts`, `src/core/archive-crawler-config.ts`
- Verify: `test/path-boundary.test.ts`, `test/check-path-sep-boundary.test.ts`, `scripts/check-path-sep-boundary.sh`
- Verify: `test/skills-conformance.test.ts`, `test/resolver.test.ts`, `test/check-frontmatter-fence.test.ts`, `scripts/check-frontmatter-fence.sh`

**Interfaces:**
- Consumes: `isPathInside(child: string, parent: string): boolean`, `isPathStrictlyInside(child: string, parent: string): boolean`, `isPathContained(child: string, parent: string): boolean`, and existing write-target confinement helper.
- Produces: verification evidence only unless a focused regression exposes a residual gap.

- [ ] **Step 1: Verify the containment implementation has the canonical boundary logic**

Required implementation shape:

```ts
const rel = relative(parent, child);
if (rel === '') return true;
if (isAbsolute(rel)) return false;
if (rel === '..' || rel.startsWith('..' + sep)) return false;
return true;
```

Realpath-backed functions must fail closed on resolution errors and delegate the final boundary decision to `isPathInside`.

- [ ] **Step 2: Run focused containment tests and static guard**

```bash
bun test test/path-boundary.test.ts test/storage.test.ts test/skillpack-copy.test.ts test/sync-path-containment.test.ts test/brain-writer.test.ts test/archive-crawler-config.test.ts test/check-path-sep-boundary.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/09-containment.txt 2>&1; test_rc=$?; bash scripts/check-path-sep-boundary.sh > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/10-containment-guard.txt 2>&1; guard_rc=$?; printf 'TEST_EXIT=%s GUARD_EXIT=%s\n' "$test_rc" "$guard_rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/10-containment-guard.txt; test "$test_rc" -eq 0 -a "$guard_rc" -eq 0
```

Expected: both exit 0. If a caller fails, change only that caller and add a regression using native `join`/`relative`; do not create another containment helper.

- [ ] **Step 3: Run focused LF/CRLF parser tests and static guard**

```bash
bun test test/skills-conformance.test.ts test/resolver.test.ts test/check-frontmatter-fence.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/11-frontmatter.txt 2>&1; test_rc=$?; bash scripts/check-frontmatter-fence.sh > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/12-frontmatter-guard.txt 2>&1; guard_rc=$?; printf 'TEST_EXIT=%s GUARD_EXIT=%s\n' "$test_rc" "$guard_rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/12-frontmatter-guard.txt; test "$test_rc" -eq 0 -a "$guard_rc" -eq 0
```

Expected: both exit 0. Normalize parsed values with `raw.replace(/\r\n/g, '\n')`; only offset-returning parsers may preserve bytes and use fence-local `\r?\n` matching.

### Task 4: Introduce the platform shell resolver

**Files:**
- Create: `src/core/minions/handlers/shell-platform.ts`
- Create: `test/shell-platform.test.ts`
- Modify: `src/core/minions/handlers/shell.ts`

**Interfaces:**
- Produces:

```ts
export interface ShellInvocation {
  executable: string;
  args: string[];
}

export function resolveShellInvocation(
  command: string,
  opts?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv },
): ShellInvocation;

export async function terminateOwnedProcessTree(
  child: ChildProcess,
  platform?: NodeJS.Platform,
): Promise<void>;
```

- `resolveShellInvocation` uses injected values only for deterministic tests; production defaults to `process.platform` and `process.env`.
- `terminateOwnedProcessTree` may target only `child.pid` created by the caller. It must not enumerate or terminate unrelated processes.

- [ ] **Step 1: Write failing resolver tests**

```ts
expect(resolveShellInvocation('printf ok', { platform: 'linux', env: {} })).toEqual({
  executable: '/bin/sh',
  args: ['-c', 'printf ok'],
});

expect(resolveShellInvocation('echo ok', {
  platform: 'win32',
  env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
})).toEqual({
  executable: 'C:\\Windows\\System32\\cmd.exe',
  args: ['/d', '/s', '/c', 'echo ok'],
});

expect(resolveShellInvocation('echo ok', { platform: 'win32', env: {} })).toEqual({
  executable: 'cmd.exe',
  args: ['/d', '/s', '/c', 'echo ok'],
});
```

Also assert an empty/whitespace `ComSpec` falls back to `cmd.exe` and that the command remains one final argument rather than being interpolated into another shell string.

- [ ] **Step 2: Run the new resolver tests red**

```bash
bun test test/shell-platform.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/13-shell-platform-red.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/13-shell-platform-red.txt; exit "$rc"
```

Expected: nonzero because `shell-platform.ts` or its exports do not exist.

- [ ] **Step 3: Implement `resolveShellInvocation` minimally**

```ts
export function resolveShellInvocation(
  command: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): ShellInvocation {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === 'win32') {
    const configured = env.ComSpec?.trim();
    return {
      executable: configured || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return { executable: '/bin/sh', args: ['-c', command] };
}
```

Do not validate `ComSpec` by probing or spawning it in the resolver; the only validation is a non-empty string. Spawn failure must remain explicit and retryable instead of silently changing execution semantics.

- [ ] **Step 4: Implement owned-tree termination and wire `shell.ts`**

For `cmd`, call the resolver and pass `executable`/`args` directly to `spawn` with `shell: false`. Keep `argv[0]` plus `argv.slice(1)` unchanged.

Termination contract:

- POSIX: send `SIGTERM` to the owned child; after the existing five-second grace send `SIGKILL` if still unsettled.
- Windows: invoke `taskkill.exe /PID String(child.pid) /T /F` only when `child.pid` is a positive integer; await that owned helper's `close`; fall back to `child.kill()` only if taskkill itself cannot start.
- The handler's abort path waits for the child result and then reports `aborted`; it does not return while descendants still own output pipes.

- [ ] **Step 5: Run resolver tests green**

```bash
bun test test/shell-platform.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/14-shell-platform-green.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/14-shell-platform-green.txt; exit "$rc"
```

Expected: exit 0 on Windows and POSIX because platform selection is injected.

### Task 5: Port shell-handler and transcript-capture fixtures

**Files:**
- Modify: `test/minions-shell.test.ts`
- Modify: `src/core/claw-test/transcript-capture.ts`
- Modify: `test/transcript-capture.test.ts`
- Create: `test/fixtures/transcript-worker.mjs`

**Interfaces:**
- Consumes: `resolveShellInvocation()` and `terminateOwnedProcessTree()` from Task 4.
- Preserves:

```ts
export async function spawnWithCapture(
  bin: string,
  args: string[],
  opts: SpawnOpts,
): Promise<SpawnResult>;
```

- Fixture modes:

```text
node transcript-worker.mjs stdout hi
node transcript-worker.mjs exit 7
node transcript-worker.mjs wait
```

- [ ] **Step 1: Add the portable transcript fixture**

```js
const [mode, value = ''] = process.argv.slice(2);
if (mode === 'stdout') {
  process.stdout.write(value);
  process.exit(0);
}
if (mode === 'exit') process.exit(Number(value));
if (mode === 'wait') setInterval(() => {}, 1000);
throw new Error(`unknown transcript worker mode: ${mode}`);
```

- [ ] **Step 2: Replace `/bin/sh` transcript test invocations**

Use `process.execPath` and `fileURLToPath(new URL('./fixtures/transcript-worker.mjs', import.meta.url))`. Build the missing executable as `join(tmp, 'missing-executable')`, not `/no/such/binary`. Keep assertions for stdout bytes, exit 7, timeout, spawn rejection, and explicit `await sink.close()` before `rmSync`.

- [ ] **Step 3: Add settle-once handling to `spawnWithCapture`**

Use one terminal guard across `error` and `close`:

```ts
let settled = false;
const settle = (fn: () => void) => {
  if (settled) return;
  settled = true;
  clearTimeout(wallClockTimer);
  if (killTimer) clearTimeout(killTimer);
  fn();
};
```

On timeout call `terminateOwnedProcessTree(child)`. Reject once on spawn error. Resolve once on close. Do not resolve after rejecting and do not leave the five-second timer alive.

- [ ] **Step 4: Port `test/minions-shell.test.ts` to native cwd and portable commands**

At file setup create one temp cwd using `mkdtempSync(join(tmpdir(), 'gbrain-minion-shell-'))` and remove it after `await engine.disconnect()`. Replace `/tmp` in handler inputs and audit records with that native directory.

Use command-string syntax by platform:

```ts
const command = process.platform === 'win32'
  ? 'echo ok'
  : 'printf "ok\\n"';
```

For direct `argv`, use:

```ts
argv: [process.execPath, '-e', 'process.stdout.write("hi\\n")']
```

For environment assertions, render `%NAME%` on Windows and `${NAME:-EMPTY}`/`$NAME` on POSIX. For long-running cancellation use direct argv with `process.execPath -e 'setInterval(() => {}, 1000)'`; this proves the direct path and avoids shell-specific `sleep`. For >64 KiB output use direct argv with `process.stdout.write('ok'.repeat(50000))`. For audit write failure use a regular file created beneath the temp root as the parent of a nonexistent child (`join(blockerFile, 'not-a-dir')`), not `/dev/null`.

- [ ] **Step 5: Run shell and transcript tests**

```bash
bun test test/shell-platform.test.ts test/minions-shell.test.ts test/transcript-capture.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/15-shell-transcript.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/15-shell-transcript.txt; exit "$rc"
```

Expected: exit 0; no `uv_spawn '/bin/sh'`; cancellation settles within the test timeout; transcript sink is closed before temp deletion.

- [ ] **Step 6: Run focused shell security regressions**

```bash
bun test test/minions-shell-inherit.test.ts test/minions-shell-redact.test.ts test/minions-shell-validate.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/16-shell-security.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/16-shell-security.txt; exit "$rc"
```

Expected: exit 0; allowlisting/redaction/protected validation remain unchanged.

### Task 6: Add explicit resolve IPC endpoints and awaited lifecycle

**Files:**
- Modify: `src/core/context/resolve-ipc.ts`
- Modify: `test/context/resolve-ipc.test.ts`
- Modify: `src/core/context/reflex.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `test/retrieval-reflex.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ResolveIpcEndpoint {
  kind: 'unix-socket' | 'windows-pipe';
  address: string;
}

export interface ResolveIpcServer {
  endpoint: ResolveIpcEndpoint;
  server: net.Server;
  sockets: Set<net.Socket>;
  close(): Promise<void>;
}

export function resolveIpcEndpoint(
  dataDir: string,
  platform?: NodeJS.Platform,
): ResolveIpcEndpoint;

export async function resolveViaIpc(
  endpoint: ResolveIpcEndpoint,
  req: ResolveRequest,
): Promise<PointerBlock | null | typeof IPC_UNAVAILABLE>;

export async function startResolveIpcServer(
  endpoint: ResolveIpcEndpoint,
  handler: ResolveHandler,
  onDelivered?: () => void,
): Promise<ResolveIpcServer>;

export function cleanupStaleIpcEndpoint(endpoint: ResolveIpcEndpoint): void;
```

- The exact existing `ResolveHandler` type and `onDelivered` semantics remain unchanged.

- [ ] **Step 1: Write endpoint-generation tests**

```ts
expect(resolveIpcEndpoint('/brain', 'linux')).toEqual({
  kind: 'unix-socket',
  address: join('/brain', '.gbrain-resolve.sock'),
});

const win = resolveIpcEndpoint('C:\\Users\\example\\brain', 'win32');
expect(win.kind).toBe('windows-pipe');
expect(win.address).toMatch(/^\\\\\.\\pipe\\gbrain-resolve-[a-f0-9]{16}$/);
expect(win.address).not.toContain('Users');
expect(resolveIpcEndpoint('C:\\Users\\example\\brain', 'win32')).toEqual(win);
```

Canonicalize the data directory with `resolve()` and on Windows lowercase the normalized string before hashing so path case does not produce duplicate endpoints for the same directory. Use a deterministic SHA-256 prefix; do not expose the source path in the pipe name.

- [ ] **Step 2: Add failing lifecycle tests**

Cover:

- Windows-pipe round trip using an injected `win32` endpoint even when the host is Windows.
- Missing named pipe returns `IPC_UNAVAILABLE` without `existsSync`.
- Unix stale artifact cleanup and mode assertions run only when `endpoint.kind === 'unix-socket'`.
- `await managed.close()` destroys accepted sockets and resolves only after `server.close()`.
- A directory can be removed immediately after `await managed.close()` for Unix endpoints.

- [ ] **Step 3: Run IPC tests red**

```bash
bun test test/context/resolve-ipc.test.ts test/retrieval-reflex.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/17-ipc-red.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/17-ipc-red.txt; exit "$rc"
```

Expected: nonzero due to absent endpoint object/managed-close contract.

- [ ] **Step 4: Implement endpoint generation and endpoint-aware client behavior**

Client preflight:

```ts
if (endpoint.kind === 'unix-socket' && !existsSync(endpoint.address)) {
  return IPC_UNAVAILABLE;
}
const sock = net.createConnection(endpoint.address);
```

Retain response-size and parse bounds. Convert connection refusal/missing-pipe errors to `IPC_UNAVAILABLE`; malformed responses remain bounded and rejected according to the existing contract.

- [ ] **Step 5: Implement managed server ownership**

On every `connection`, add the socket to a set and remove it on `close`. `close()` must be idempotent:

```ts
async close(): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
  cleanupStaleIpcEndpoint(endpoint);
}
```

Handle an already-closed server as success. Call stale cleanup before `listen` only for Unix. Call `chmodSync(address, 0o600)` only for Unix after successful listen.

- [ ] **Step 6: Update all consumers**

- `reflex.ts`: `const endpoint = resolveIpcEndpoint(cfg.database_path); await resolveViaIpc(endpoint, ...)`.
- `mcp/server.ts`: store `ResolveIpcServer | null`; shutdown becomes async and idempotent; await managed IPC close, then `engine.disconnect()`, then exit.
- `doctor.ts`: Unix uses `existsSync(endpoint.address)` for visibility; Windows reports `pglite via serve IPC named pipe` as configured but does not claim liveness from filesystem visibility. Preserve the existing recent-runtime-signal logic for status.
- `retrieval-reflex.test.ts`: pass an endpoint object to client/server helpers.

- [ ] **Step 7: Run IPC/reflex tests green**

```bash
bun test test/context/resolve-ipc.test.ts test/retrieval-reflex.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/18-ipc-green.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/18-ipc-green.txt; exit "$rc"
```

Expected: exit 0; Unix artifact tests are conditional; named-pipe round trip passes on Windows; no temp-directory `EBUSY`.

- [ ] **Step 8: Run focused serve and doctor consumers**

```bash
bun test test/serve-stdio-lifecycle.test.ts test/doctor-frontmatter-partial.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/19-ipc-consumers.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/19-ipc-consumers.txt; exit "$rc"
```

Expected: exit 0; stdio shutdown closes IPC before engine disconnect; doctor output does not use filesystem existence for a Windows pipe.

### Task 7: Add exact symlink capability gates

**Files:**
- Create: `test/helpers/fs-capabilities.ts`
- Modify exact-capability tests as needed:
  - `test/brain-writer.test.ts`
  - `test/extract/benchmark.test.ts`
  - `test/file-upload-security.test.ts`
  - `test/files.test.ts`
  - `test/import-file.test.ts`
  - `test/import-checkpoint.test.ts`
  - `test/import-walker.test.ts`
  - `test/ingestion/sources/inbox-folder.test.ts`
  - `test/migrations-v0_11_0.test.ts`
  - `test/path-confine.test.ts`
  - `test/scripts/ci-cache-hash.test.ts`
  - `test/skillpack-copy.test.ts`
  - `test/skillpack-harvest.test.ts`
  - `test/skillpack-tarball.test.ts`
  - `test/sources-ops.test.ts`
  - `test/sync-monorepo.test.ts`
  - `test/sync-walker-symlink.test.ts`

**Interfaces:**
- Produces:

```ts
export interface FsCapabilities {
  fileSymlink: boolean;
  directorySymlink: boolean;
  directoryJunction: boolean;
  gitSymlinkCheckout: boolean;
}

export function getFsCapabilities(root?: string): FsCapabilities;
```

- `root` defaults to a fresh directory beneath `tmpdir()`. When a fixture's filesystem may differ, call with that fixture's root before creating test data.

- [ ] **Step 1: Write focused helper tests inside the helper's first consumer**

Assert the result has four booleans and is cached by canonical root. The probe must clean up its own files before returning. Do not assert that a Windows host supports any specific capability; assert that a `true` value corresponds to a successful create/read/remove cycle.

- [ ] **Step 2: Implement distinct filesystem probes**

Within a probe directory:

- File symlink: create a target file, `symlinkSync(target, link, 'file')`, read through link, remove link.
- Directory symlink: create a target directory, `symlinkSync(target, link, 'dir')`, inspect through link, remove link.
- Directory junction: Windows uses `symlinkSync(target, link, 'junction')`; non-Windows may report `false` because junction semantics are Windows-specific.
- Catch `EPERM`, `EACCES`, `ENOTSUP`, and `UNKNOWN` as an unavailable capability. Rethrow unrelated failures so broken probes do not silently skip tests.

- [ ] **Step 3: Implement the Git mode-`120000` probe separately**

Create a temporary repository, write a blob containing `target.txt`, add it to the index with:

```bash
git update-index --add --cacheinfo 120000,<blob-sha>,link.txt
```

Commit, remove the worktree path, then `git checkout -- link.txt`. Set `gitSymlinkCheckout` true only when `lstatSync(link).isSymbolicLink()` is true. This detects `core.symlinks=false` materialization and must not be inferred from `fileSymlink`.

- [ ] **Step 4: Gate every direct symlink fixture by its exact capability**

Use `test.skipIf(!caps.fileSymlink)` only for file-link construction, `test.skipIf(!caps.directorySymlink)` for directory-link construction, and `test.skipIf(!caps.gitSymlinkCheckout)` for checkout semantics. Keep unrelated tests in each file running. Do not substitute a junction where a file symlink is the subject.

For `test/scripts/ci-cache-hash.test.ts`, retain the index/blob hash assertion and skip only the `symlink target change affects hash` test when Git cannot materialize mode `120000`. Do not blanket-skip the file.

- [ ] **Step 5: Run the symlink-dependent files in bounded groups**

```bash
bun test test/path-confine.test.ts test/file-upload-security.test.ts test/files.test.ts test/import-file.test.ts test/import-checkpoint.test.ts test/import-walker.test.ts test/sync-walker-symlink.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/20-symlink-core.txt 2>&1; rc1=$?; bun test test/brain-writer.test.ts test/skillpack-copy.test.ts test/skillpack-harvest.test.ts test/skillpack-tarball.test.ts test/sources-ops.test.ts test/sync-monorepo.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/21-symlink-domain.txt 2>&1; rc2=$?; bun test test/extract/benchmark.test.ts test/ingestion/sources/inbox-folder.test.ts test/migrations-v0_11_0.test.ts test/scripts/ci-cache-hash.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/22-symlink-remaining.txt 2>&1; rc3=$?; printf 'CORE_EXIT=%s DOMAIN_EXIT=%s REMAINING_EXIT=%s\n' "$rc1" "$rc2" "$rc3" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/22-symlink-remaining.txt; test "$rc1" -eq 0 -a "$rc2" -eq 0 -a "$rc3" -eq 0
```

Expected: all commands exit 0; tests either pass or report explicit capability-specific skips. No setup `EPERM` poisons sibling tests.

### Task 8: Reconcile child-worker spawn settlement and portable harnesses

**Files:**
- Modify: `src/core/minions/child-worker-supervisor.ts`
- Modify: `test/child-worker-supervisor.test.ts`

**Interfaces:**
- Consumes: existing `ChildWorkerSupervisorOptions`, event union, backoff, crash-count, and hard-stop policies.
- Produces: settle-once handling where spawn failure emits existing `worker_spawn_failed` plus:

```ts
{
  kind: 'worker_exited';
  code: null;
  signal: null;
  runDurationMs: number;
  likelyCause: 'spawn_failed';
  crashCount: number;
}
```

- Test harness:

```ts
interface Harness {
  cliPath: string;
  args: string[];
  cleanup(): void;
}
```

- [ ] **Step 1: Replace executable `.sh` fixtures with portable harnesses**

Use `process.execPath` plus generated `.mjs` scripts for stateful workers. Use a constant-exit platform harness only when shell semantics are the subject:

```ts
return process.platform === 'win32'
  ? { cliPath: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `exit ${code}`], cleanup() {} }
  : { cliPath: '/bin/sh', args: ['-c', `exit ${code}`], cleanup() {} };
```

For file-based counters, resolve sibling paths with `fileURLToPath(new URL('./counter', import.meta.url))`.

- [ ] **Step 2: Add the failed-spawn regression and two-stage hang net**

Test a nonexistent `cliPath` under the test temp root. Expect each failed attempt to emit `worker_spawn_failed` and a matching `worker_exited` with `likelyCause: 'spawn_failed'` and increasing crash count. Expect the configured hard stop to bound retries.

The harness uses:

```ts
const TEST_TIMEOUT_MS = 60_000;
const RUN_DEADLINE_MS = 30_000;
const RUN_ABANDON_GRACE_MS = 5_000;
```

At soft deadline set stopping and kill only `supervisor.currentChild`. At hard deadline reject with a descriptive error containing the latest events. The Bun test timeout remains `TEST_TIMEOUT_MS` so the harness error wins.

- [ ] **Step 3: Run the new regression red**

```bash
bun test test/child-worker-supervisor.test.ts -t 'failed spawn' --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/23-child-worker-red.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/23-child-worker-red.txt; exit "$rc"
```

Expected: nonzero or controlled harness deadline because current code waits for `exit` that never arrives.

- [ ] **Step 4: Implement settle-once spawn failure**

Inside `spawnOnce()` use:

```ts
let settled = false;
let spawnErrored = false;

const settleSpawnFailure = () => {
  if (settled) return;
  settled = true;
  this._child = null;
  this._intentionalRestart = false;
  if (this.opts.isStopping()) {
    resolve();
    return;
  }
  const runDuration = this.now() - this._lastStartTime;
  this._lastExitCode = null;
  this._crashCount++;
  this.opts.onEvent({
    kind: 'worker_exited',
    code: null,
    signal: null,
    runDurationMs: runDuration,
    likelyCause: 'spawn_failed',
    crashCount: this._crashCount,
  });
  resolve();
};
```

`error` records `worker_spawn_failed`, sets `spawnErrored`, and settles immediately when `child.pid === undefined`. `close` settles only when `spawnErrored`. `exit` returns immediately if already settled; otherwise it runs existing healthy/crash classification once. Preserve current backoff and stop logic.

- [ ] **Step 5: Run the child-worker file green**

```bash
bun test test/child-worker-supervisor.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/24-child-worker-green.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/24-child-worker-green.txt; exit "$rc"
```

Expected: exit 0; missing executable settles; no test reaches the harness hard deadline.

### Task 9: Port `MinionSupervisor` integration fixtures and platform timing

**Files:**
- Modify: `test/supervisor.test.ts`
- Verify: `test/fixtures/supervisor-runner.ts`
- Verify: `src/core/minions/supervisor.ts`

**Interfaces:**
- Produces test-only semantic fixture:

```ts
type WorkerSpec =
  | { kind: 'exit' }
  | { kind: 'record-env'; varName: string }
  | { kind: 'record-argv' };

interface RenderedWorker {
  filename: 'worker.cmd' | 'worker.sh';
  contents: string;
}
```

- Timing constants:

```ts
const INTEGRATION_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 45_000;
```

- [ ] **Step 1: Render semantic workers for both platforms**

Windows fixtures use `@echo off\r\n` and `exit /b 1`; POSIX fixtures use `#!/bin/sh\n` and `exit 1`. Render environment and appended-argument recording from `WorkerSpec`; do not hand-maintain two unrelated test meanings. Call `chmodSync(..., 0o755)` only when `process.platform !== 'win32'`.

- [ ] **Step 2: Replace global `/tmp` PID state**

Create a per-test root beneath `tmpdir()` and set the supervisor PID file to `join(root, 'supervisor.pid')`. Restore relevant environment variables before deleting the root.

- [ ] **Step 3: Separate graceful POSIX signal semantics from Windows termination semantics**

```ts
const describeSigterm = process.platform === 'win32' ? describe.skip : describe;
```

Place only tests that require a catchable shell `SIGTERM` handler inside `describeSigterm`. Add the explicit reason in the suite name/comment: Windows `child.kill('SIGTERM')` terminates the process and cannot prove the POSIX graceful-handler contract. Keep all non-signal lifecycle tests active on Windows.

- [ ] **Step 4: Raise only hang-net budgets above the measured Windows floor**

Use 45 seconds to wait for readiness and 60 seconds for the enclosing test. Do not assert that healthy startup must be faster than 14 seconds; timing is not the product contract.

- [ ] **Step 5: Run supervisor integration tests**

```bash
bun test test/supervisor.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/25-supervisor.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/25-supervisor.txt; exit "$rc"
```

Expected: exit 0; only graceful-SIGTERM tests are skipped on Windows; `.cmd` workers execute and PID paths are native.

- [ ] **Step 6: Run focused supervisor neighbors**

```bash
bun test test/supervisor-build-worker-args.test.ts test/supervisor-pid.test.ts test/supervisor-wedge.test.ts test/autopilot-supervisor-wiring.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/26-supervisor-neighbors.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/26-supervisor-neighbors.txt; exit "$rc"
```

Expected: exit 0; production worker arguments and wedge handling remain unchanged.

### Task 10: Fix deterministic cwd and resolve-IPC teardown

**Files:**
- Modify: `test/code-callers-pin.serial.test.ts`
- Modify: `test/context/resolve-ipc.test.ts` if Task 6 did not fully migrate every test

**Interfaces:**
- Consumes: `ResolveIpcServer.close(): Promise<void>` from Task 6.
- Produces: reverse-order teardown; no new production interface.

- [ ] **Step 1: Fix all nine cwd cleanup inversions**

Every test that calls `process.chdir(dir)` uses:

```ts
const origCwd = process.cwd();
process.chdir(dir);
try {
  // assertions
} finally {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
}
```

Do not rely on `afterEach` to restore cwd after the body-local `rmSync`; that hook runs too late.

- [ ] **Step 2: Ensure every IPC test awaits closure before deletion**

Each test follows:

```ts
let managed: ResolveIpcServer | null = null;
try {
  managed = await startResolveIpcServer(endpoint, handler);
  // assertions
} finally {
  await managed?.close();
  rmSync(dir, { recursive: true, force: true });
}
```

Do not push bare `net.Server` values into an array and call non-awaited `close()` in `afterEach`.

- [ ] **Step 3: Run cleanup-sensitive tests independently**

```bash
bun test test/code-callers-pin.serial.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/27-code-callers-cleanup.txt 2>&1; rc1=$?; bun test test/context/resolve-ipc.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/28-ipc-cleanup.txt 2>&1; rc2=$?; printf 'CODE_CALLERS_EXIT=%s IPC_EXIT=%s\n' "$rc1" "$rc2" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/28-ipc-cleanup.txt; test "$rc1" -eq 0 -a "$rc2" -eq 0
```

Expected: both exit 0; no `EBUSY`; no listener remains after test completion.

### Task 11: Suppress durability hook races and preserve cleanup verdicts

**Files:**
- Modify: `src/core/brain-repo-durability.ts`
- Modify: `test/brain-repo-durability.serial.test.ts`

**Interfaces:**
- Existing public durability API remains unchanged.
- Internal scaffolding commit invokes:

```ts
execFileSync('git', [
  '-C', repoPath,
  '-c', 'core.hooksPath=/dev/null',
  'commit', '-m', 'chore(gbrain): install brain durability scaffolding',
], options);
```

- Test cleanup helper returns or throws an error after bounded retries; it never silently swallows final failure.

- [ ] **Step 1: Add hook-suppression regressions**

After hardening a fixture repo, assert:

```ts
expect(existsSync(join(repoPath, '.git', 'gbrain', 'brain-push.log'))).toBe(false);
const hook = readFileSync(hookPath, 'utf8');
expect(hook).toContain('core.hooksPath=/dev/null');
expect(hook).not.toContain('commit --no-verify');
```

The first assertion must be taken immediately after the internal scaffolding commit, before any test-triggered commit that is expected to exercise the detached hook.

- [ ] **Step 2: Run the regression red**

```bash
bun test test/brain-repo-durability.serial.test.ts -t 'scaffolding commit' --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/29-durability-red.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/29-durability-red.txt; exit "$rc"
```

Expected: nonzero because the current internal commit fires the installed post-commit hook or the hook text advertises the ineffective `--no-verify` bypass.

- [ ] **Step 3: Suppress the post-commit hook only for the internal scaffolding commit**

Add `'-c', 'core.hooksPath=/dev/null'` before `commit`. Update the generated hook comment to explain that `--no-verify` skips pre-commit/commit-msg hooks but not post-commit hooks. Production's normal detached push behavior remains unchanged for user commits.

- [ ] **Step 4: Replace fixed sleeps with observable quiescence**

After a test-triggered commit, poll the owned `brain-push.log` and target bare-repository ref until either the expected ref appears and the log stops changing for two consecutive intervals, or a bounded deadline expires. Do not enumerate or kill global Git processes.

- [ ] **Step 5: Preserve primary and cleanup errors**

Store a body error if one occurs. Cleanup order:

1. Restore environment/global state.
2. Wait for fixture-owned push quiescence.
3. Remove the tree with bounded Windows retries on `EBUSY`/`EPERM` only.
4. If cleanup fails and the body passed, throw cleanup error.
5. If both fail, throw the body error with cleanup attached as `cause` or an `AggregateError` whose first error is the body failure.

Gate executable-mode assertions with `process.platform !== 'win32'`; do not reinterpret Windows ACLs as POSIX mode bits.

- [ ] **Step 6: Run durability tests green**

```bash
bun test test/brain-repo-durability.serial.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/30-durability-green.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/30-durability-green.txt; exit "$rc"
```

Expected: exit 0; internal scaffolding creates no detached-push log; explicit user-commit tests still observe the hook; temp removal succeeds after quiescence.

### Task 12: Verify residual native-path and subprocess assumptions

**Files:**
- Verify: master-integrated assertion and shim changes
- Modify only an exact file that still fails a focused test

**Interfaces:**
- Native filesystem paths use `join`, `resolve`, `relative`, `REPO_ROOT`, `repoPath`, and `fileURLToPath`.
- Conversion to `/` is permitted only at Git-relative, URL, slug, or object-key boundaries.

- [ ] **Step 1: Run the static URL/path guards**

```bash
bash scripts/check-url-pathname-fs.sh > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/31-url-pathname-guard.txt 2>&1; rc1=$?; bash scripts/check-path-sep-boundary.sh > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/32-path-sep-guard.txt 2>&1; rc2=$?; printf 'URL_EXIT=%s SEP_EXIT=%s\n' "$rc1" "$rc2" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/32-path-sep-guard.txt; test "$rc1" -eq 0 -a "$rc2" -eq 0
```

Expected: both exit 0.

- [ ] **Step 2: Run focused assertion/shim regressions already integrated on master**

```bash
bun test test/check-url-pathname-fs.test.ts test/check-path-sep-boundary.test.ts test/no-tracked-symlinks-guard.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/33-path-shim-tests.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/33-path-shim-tests.txt; exit "$rc"
```

Expected: exit 0. If a failure remains, write a focused regression in that same file before changing production code. Never globally replace `sep` with `/`.

### Task 13: Diagnose the four stalled chunks file by file

**Files:**
- Diagnose and modify only confirmed roots among:
  - `test/check-url-pathname-fs.test.ts`
  - `test/child-worker-supervisor.test.ts`
  - `test/chronicle-advisor.test.ts`
  - `test/chronicle-backfill.test.ts`
  - `test/post-install-advisory.test.ts`
  - `test/post-write-lint.test.ts`
  - `test/postgres-disconnect-bounded.test.ts`
  - `test/postgres-engine-config-reconnect.test.ts`
  - `test/serve-skills-publish-nudge.test.ts`
  - `test/serve-stdio-lifecycle.test.ts`
  - `test/setup-branching.test.ts`
  - `test/skill-brain-first.test.ts`
  - `test/timeline-entry-subagent-fence.test.ts`
  - `test/timeout.test.ts`
  - `test/timing-safe.test.ts`
  - `test/token-budget.test.ts`

**Interfaces:**
- Consumes: focused fixes from Tasks 8–12.
- Produces: one evidence row per file (`exit`, elapsed bound, last lifecycle event), then only evidence-driven ordered-pair dispositions. No speculative code change.

- [ ] **Step 1: Run each file alone in a fresh Bun process with complete redirected output**

Use this exact loop; it invokes explicit files, never a directory or suite:

```bash
files=(
  test/check-url-pathname-fs.test.ts
  test/child-worker-supervisor.test.ts
  test/chronicle-advisor.test.ts
  test/chronicle-backfill.test.ts
  test/post-install-advisory.test.ts
  test/post-write-lint.test.ts
  test/postgres-disconnect-bounded.test.ts
  test/postgres-engine-config-reconnect.test.ts
  test/serve-skills-publish-nudge.test.ts
  test/serve-stdio-lifecycle.test.ts
  test/setup-branching.test.ts
  test/skill-brain-first.test.ts
  test/timeline-entry-subagent-fence.test.ts
  test/timeout.test.ts
  test/timing-safe.test.ts
  test/token-budget.test.ts
)
summary=C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/34-stalled-files-summary.txt
: > "$summary"
for file in "${files[@]}"; do
  slug="${file#test/}"; slug="${slug//\//-}"
  log="C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/34-${slug}.txt"
  bun test "$file" --timeout=60000 > "$log" 2>&1
  rc=$?
  printf '%s EXIT=%s LOG=%s\n' "$file" "$rc" "$log" >> "$summary"
done
```

Expected: all invocations terminate. Passing files report exit 0. Any nonzero file gets a root-cause investigation from its complete log before any pair run.

- [ ] **Step 2: Classify individual failures without changing unrelated files**

For each nonzero file, identify whether the failure is:

- a test assertion,
- a setup/hook timeout,
- an owned child/listener that prevented exit,
- cleanup masking,
- or an environmental precondition already expressed by the test.

Add the smallest failing regression to that exact file or its direct production unit, implement one root fix, and rerun only that file. Do not attribute a file's failure to chunk peers without evidence.

- [ ] **Step 3: Run original ordered pairs only when both files passed alone**

For each original chunk, start with adjacent pairs in original order: `(A,B)`, `(B,C)`, `(C,D)`. If one adjacent pair stalls/fails, run the reverse `(B,A)` to establish directionality. Do not enumerate every permutation unless a prior pair proves interaction.

Example command shape:

```bash
bun test test/check-url-pathname-fs.test.ts test/child-worker-supervisor.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/35-pair-32-ab.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/35-pair-32-ab.txt; exit "$rc"
```

Repeat with unique filenames for each evidence-driven pair. Expected: exit 0, or a bounded nonzero result with a complete log identifying ordering/global-state ownership. Never kill machine-wide Bun/Git processes.

- [ ] **Step 4: Add condition-based lifecycle waits for confirmed pair interactions**

When a pair proves a leaked resource, wait on an observable owned condition: child `close`, server `close`, engine `disconnect`, output-log quiescence, ref appearance, or restored environment/cwd. Do not fix a lifecycle interaction by merely increasing an arbitrary sleep.

- [ ] **Step 5: Re-run only the affected file and proven pair**

Expected: both exit 0 within 60 seconds. Record the before/after log paths and exact root in `34-stalled-files-summary.txt`.

### Task 14: Run focused family gates and typecheck

**Files:**
- Verify all files changed by Tasks 2–13
- Inspect: `docs/architecture/KEY_FILES.md` entries for any modified `src/` file
- Update reference docs only if current behavior changed and the relevant entry requires it

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: bounded verification evidence; no full-suite claim.

- [ ] **Step 1: Run the consolidated focused test set in separate bounded processes**

Runner:

```bash
bun test test/scripts/run-unit-parallel.test.ts test/scripts/run-unit-shard.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/36-final-runner.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/36-final-runner.txt; exit "$rc"
```

Shell/transcript:

```bash
bun test test/shell-platform.test.ts test/minions-shell.test.ts test/minions-shell-inherit.test.ts test/minions-shell-redact.test.ts test/minions-shell-validate.test.ts test/transcript-capture.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/37-final-shell.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/37-final-shell.txt; exit "$rc"
```

IPC/cleanup:

```bash
bun test test/context/resolve-ipc.test.ts test/retrieval-reflex.test.ts test/code-callers-pin.serial.test.ts test/brain-repo-durability.serial.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/38-final-cleanup.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/38-final-cleanup.txt; exit "$rc"
```

Supervisor:

```bash
bun test test/child-worker-supervisor.test.ts test/supervisor.test.ts test/supervisor-build-worker-args.test.ts test/supervisor-pid.test.ts test/supervisor-wedge.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/39-final-supervisor.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/39-final-supervisor.txt; exit "$rc"
```

Expected: every command exits 0. If cross-file contamination appears only in a consolidated command, reduce it to the smallest ordered pair before changing code.

- [ ] **Step 2: Run all relevant static guards individually**

```bash
{
  bash scripts/check-frontmatter-fence.sh
  bash scripts/check-path-sep-boundary.sh
  bash scripts/check-url-pathname-fs.sh
} > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/40-static-guards.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/40-static-guards.txt; exit "$rc"
```

Expected: exit 0.

- [ ] **Step 3: Run typecheck with complete capture**

```bash
bun run typecheck > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/41-typecheck.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/41-typecheck.txt; exit "$rc"
```

Expected: exit 0.

- [ ] **Step 4: If `docs/architecture/KEY_FILES.md`, `docs/TESTING.md`, or `CLAUDE.md` changed, regenerate and test llms bundles**

Do not edit `CLAUDE.md` unless current architecture truly requires it. For any reference-doc change, run:

```bash
bun run build:llms > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/42-build-llms.txt 2>&1; rc1=$?; bun test test/build-llms.test.ts --timeout=60000 > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/43-build-llms-test.txt 2>&1; rc2=$?; printf 'BUILD_EXIT=%s TEST_EXIT=%s\n' "$rc1" "$rc2" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/43-build-llms-test.txt; test "$rc1" -eq 0 -a "$rc2" -eq 0
```

Expected: both exit 0. Linked docs may leave bundle bytes unchanged; `test/build-llms.test.ts` is the authoritative freshness gate.

- [ ] **Step 5: Review final diff for forbidden regressions**

```bash
{
  git status --short
  git diff --stat
  git diff --check
  git diff -- src/core/path-confine.ts src/core/minions/handlers/shell.ts src/core/context/resolve-ipc.ts src/core/minions/child-worker-supervisor.ts src/core/brain-repo-durability.ts scripts/run-unit-parallel.sh scripts/run-unit-shard.sh
} > C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/44-final-diff-review.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc" >> C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/44-final-diff-review.txt; exit "$rc"
```

Expected: exit 0; no source-isolation, trust-boundary, shell-policy, or realpath-confinement weakening; no version bump, changelog release entry, commit, push, or PR artifacts.

## Completion report requirements

The implementation report must include:

1. The exact pinned integration SHA used and the preserved stale-runner ref.
2. A nine-row area table distinguishing retained master work, newly implemented work, and any capability-specific skips.
3. Focused commands and exit codes, linked to the full logs under `C:/Users/diego/AppData/Local/Temp/gbrain-win-portability-20260729/`.
4. One evidence-backed disposition for each of the sixteen files in the four stalled chunks, including any ordered pair that exposed interaction.
5. Any remaining failure with primary versus cleanup/secondary error clearly separated.
6. An explicit statement that the complete Windows suite was not rerun and no complete-suite pass is claimed.
7. An explicit statement that no unrelated processes were killed and no dynamic-import investigation was performed.
