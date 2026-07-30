# Windows Test Portability Design

**Date:** 2026-07-29  
**Status:** Approved  
**Scope:** Remediate the nine root-cause areas identified by the complete Windows `bun run test` triage for commit `8719634599c35ba0a63834a2f0422fa192629793`.

## Context

The authoritative Windows run completed naturally with 13,342 passing tests, 470 failures, 4 skips, and exit code 1. It recorded 14 `/bin/sh` spawn failures and no commitment-limit, commitment-exhaustion, or unexplained-truncation signatures. The failure ledger separated direct causes from cascades, setup poisoning, cleanup masking, and four independently stalled test chunks.

The verification branch contains one unique commit, `87196345`, which bounds Windows unit-runner memory. It is 348 commits behind the local master inspected during design. Master already contains the complete portable-containment and CRLF work, plus substantial native-path assertion and subprocess-shim fixes. The implementation must reconcile these histories rather than recreate all nine fixes on the stale branch.

## Constraints

- Do not rerun the complete Windows suite during implementation.
- Do not revisit or expand the disputed dynamic-import theory.
- Do not kill unrelated processes.
- Preserve fail-closed trust boundaries, source isolation, and symlink-escape prevention.
- Preserve the protected shell-job gate and direct-argv no-shell behavior.
- Capture complete command output before inspecting it; never pipe a test command through `head` or `tail`.
- Do not weaken POSIX security assertions to make Windows setup pass.
- Do not claim the complete Windows suite is green without a new complete run.

## Integration strategy

Use a pinned current-master commit as the integration baseline and replay or otherwise preserve the unique `87196345` runner patch. Implement only gaps that remain after reconciliation.

This is preferred to merging current master into the stale branch because it minimizes accidental reverts and makes the final portability delta reviewable. Implementing against `87196345` first is rejected because it would duplicate hundreds of already-integrated changes and maximize merge conflicts.

Before changing history:

1. Record the exact master SHA.
2. Confirm the worktree is clean.
3. Preserve the current branch reference.
4. Integrate onto the pinned master.
5. Verify the runner patch remains present using a three-dot diff and patch comparison, not branch ancestry alone.

## Area 1: Filesystem containment

Retain master’s shared native-filesystem containment design unchanged unless reconciliation exposes a regression.

### Interfaces

- `isPathInside(child, parent)` performs inclusive lexical containment with `path.relative()`.
- `isPathStrictlyInside(child, parent)` excludes equality.
- `isPathContained(child, parent)` resolves both existing paths before checking their boundary.
- `isWriteTargetContained(target, parent)` preserves realpath-based protection for a target that may not exist yet.

A relative result that is absolute is outside the parent. This handles Windows cross-volume paths. `..` and `..${sep}` reject traversal and sibling-prefix collisions.

### Domain boundary

Native paths remain native through filesystem operations and assertions. Conversion to `/` occurs only at explicit Git-relative, URL, slug, or object-key boundaries. Forward-slash comparisons are valid only after every operand has entered that logical domain.

### Verification

Retain central path-boundary tests, caller-level regressions, and the static separator-boundary guard already on master.

## Area 2: CRLF-tolerant frontmatter tests

Retain master’s normalize-once behavior:

```ts
const content = raw.replace(/\r\n/g, "\n");
```

LF-oriented parsing then operates on the normalized string. Opening-fence assertions accept `\r?\n`.

Parsers that return byte offsets into the original input are the exception: they tolerate CRLF at fences without normalizing the source and corrupting offsets.

Retain the static frontmatter guard and the focused skills-conformance and resolver regressions.

## Area 3: Portable shell execution

Separate shell policy from platform invocation.

### Existing public contract

- `argv` means direct executable invocation without a shell.
- `cmd` means command-string execution through the selected platform shell.
- Shell jobs remain protected by `GBRAIN_ALLOW_SHELL_JOBS=1` and unavailable to remote MCP submission paths.

### Platform resolver

A narrow resolver returns an executable and argument vector:

```ts
interface ShellInvocation {
  executable: string;
  args: string[];
}
```

Resolution:

- POSIX: `/bin/sh`, `['-c', command]`.
- Windows: a validated `ComSpec` or `cmd.exe`, with non-interactive command arguments such as `['/d', '/s', '/c', command]`.

The handler passes the returned vector directly to `spawn`; it does not construct another shell string. The direct `argv` path remains unchanged.

### Security and cancellation

Environment inheritance remains allow-listed and audited without logging secret values. Cancellation must terminate only the owned process tree. Platform-specific termination belongs behind a process-supervision boundary rather than being embedded in command parsing.

### Tests

- Shell-semantic tests exercise the platform resolver.
- Generic subprocess and transcript tests use `process.execPath` plus portable fixtures instead of `/bin/sh`.
- Tests preserve coverage for command output, stderr capture, timeout, cancellation, environment filtering, audit records, and direct-argv behavior.

## Area 4: Resolve IPC named pipes

Represent an IPC endpoint explicitly:

```ts
interface ResolveIpcEndpoint {
  kind: 'unix-socket' | 'windows-pipe';
  address: string;
}
```

### Endpoint generation

- POSIX uses the existing socket under the configured data directory.
- Windows uses a deterministic, user-scoped named pipe such as `\\.\pipe\gbrain-resolve-<hash>`, derived from the canonical data directory without exposing the path verbatim.

### Lifecycle

Unix-only operations:

- Check and unlink a stale socket artifact.
- Apply mode `0600` after listen.
- Remove the socket artifact after server closure.

Windows behavior:

- Do not use `existsSync`, `unlink`, or `chmod` on the named pipe.
- Connect directly and preserve fail-soft client behavior when no server is listening.

The server tracks accepted sockets. Shutdown destroys remaining accepted connections, awaits the `server.close()` callback, removes any Unix socket artifact, and only then permits temporary-directory cleanup.

### Tests

Common round-trip and error behavior remains shared. Filesystem existence, stale-file cleanup, and mode assertions run only for Unix endpoints. Windows tests assert endpoint form and successful named-pipe round trips.

## Area 5: Symlink fixture gating

Gate the exact capability required by each fixture; do not blanket-skip Windows and do not weaken production security checks.

### Capability classes

A cached helper distinguishes:

```ts
interface FsCapabilities {
  fileSymlink: boolean;
  directorySymlink: boolean;
  directoryJunction: boolean;
}
```

Use a same-filesystem probe where direct filesystem symlink creation is the complete requirement.

Git mode-`120000` behavior is a separate capability. A successful `symlinkSync()` does not prove that Git will check out a symlink when `core.symlinks=false`. Tests whose subject is Git symlink semantics require a Git-level probe or a deterministic Git-plumbing fixture. An individual test is explicitly skipped when its full semantics cannot be represented.

Junctions are used only when their semantics match the product behavior under test. They do not substitute for file symlinks.

Security tests that do not require privileged symlink construction continue to run on Windows.

## Area 6: Native path assertions

Retain the master-integrated assertion sweep and inspect only exact failing files for residual POSIX assumptions.

Rules:

- Build native paths with `join`, `resolve`, `relative`, `REPO_ROOT`, or `repoPath`.
- Compare normalized native values or path components.
- Use `/` only for logical Git-relative, URL, slug, or object-key values.
- Do not fold arbitrary filesystem paths to `/`; that can hide mixed-separator product defects.
- Never derive filesystem paths with `new URL(...).pathname`; use `fileURLToPath()`.

Every remaining assertion change needs a focused Windows regression and must preserve POSIX semantics.

## Area 7: Portable subprocess fixtures

Choose the fixture according to the API seam.

### Executable plus caller-controlled arguments

Use `process.execPath` plus a `.mjs` fixture. This is preferred for transcript capture and ordinary subprocess tests.

### Single executable path with callee-owned arguments

Use a `.cmd` fixture on Windows and an executable `.sh` fixture on POSIX. This is required for `MinionSupervisor`, which accepts only `cliPath` and appends its own worker arguments.

A semantic worker specification renders both platform forms from one source of intent, for example:

- Exit with a constant code.
- Record selected environment state.
- Record the appended argument vector.

This avoids duplicating test meaning in unrelated shell snippets.

### Supervisor spawn settlement

A child that never launches may emit `error` and `close` without `exit`. The child-worker spawn loop must settle exactly once on every terminal combination. It must not wedge waiting for an event that can no longer occur.

Windows-impossible SIGTERM-handler assertions are explicitly skipped with an evidence-based reason. They are not replaced by a weaker assertion pretending to cover graceful signal handling.

Timeouts are bounded hang nets above the measured healthy startup floor, not performance requirements.

## Area 8: Deterministic teardown

All affected tests release resources in reverse acquisition order before recursive deletion.

### General sequence

1. Retain the primary test verdict.
2. Restore process-global state such as the current working directory.
3. Destroy accepted sockets and await server closure.
4. Await database or engine disconnection.
5. Await or observe completion of owned child work.
6. Remove temporary trees with bounded Windows retries.

Cleanup failures do not replace an earlier assertion failure. They are attached as secondary context. If the body passed and cleanup exhausts its retry budget, cleanup still fails the test; leaks are not swallowed.

### Targeted corrections

- `code-callers-pin.serial.test.ts`: restore the original current directory before removing each test directory.
- `context/resolve-ipc.test.ts`: close and await the server before removing the endpoint directory.
- `brain-repo-durability.serial.test.ts`: replace unowned detached-push timing with a concrete completion or quiescence signal. Retry-and-swallow deletion is insufficient because it can conceal real leaks.

Any product-level test hook introduced for durability must preserve production’s detached behavior by default and expose control only through an explicit injected seam.

## Area 9: Supervisor and stalled chunks

### Known supervisor roots

Reconcile the complementary proven fixes:

- Render Windows-executable supervisor workers.
- Settle the child spawn loop when a process never launches.
- Raise integration hang nets above the measured healthy Windows floor.
- Skip only the graceful SIGTERM-handler behavior Windows cannot represent.

### Four stalled chunks

Do not assume all files in a chunk share one cause. Diagnose each file independently:

1. Run the file alone with a bounded timeout and full redirected output.
2. If it passes alone, run ordered pairs to detect leaked global state, child processes, listeners, or handles.
3. Census only children owned by that test command.
4. Replace arbitrary sleeps with condition-based waits for observable lifecycle state.
5. Add a focused regression for each confirmed root.

The four original chunks are:

- `check-url-pathname-fs`, `child-worker-supervisor`, `chronicle-advisor`, `chronicle-backfill`.
- `post-install-advisory`, `post-write-lint`, `postgres-disconnect-bounded`, `postgres-engine-config-reconnect`.
- `serve-skills-publish-nudge`, `serve-stdio-lifecycle`, `setup-branching`, `skill-brain-first`.
- `timeline-entry-subagent-fence`, `timeout`, `timing-safe`, `token-budget`.

A file that passes alone is not declared fixed until the interaction that stalled its chunk is understood or bounded evidence shows the original timeout came from another file’s owned resources.

## Error handling

- Containment checks remain fail-closed.
- Missing IPC servers fail soft for resolve lookups; malformed responses remain bounded and rejected.
- Shell resolver failure returns a clear platform-specific execution error without silently falling back to direct execution.
- Child spawn settlement is idempotent across `error`, `exit`, and `close` event orderings.
- Cleanup retries are bounded and preserve both primary and secondary errors.
- Capability skips state the missing behavior explicitly and leave capable-platform assertions untouched.

## Verification plan

Verification is family-scoped:

1. Containment tests and separator-boundary guard.
2. Frontmatter tests and CRLF static guard.
3. Shell-handler and transcript-capture tests.
4. Resolve-IPC tests on the platform endpoint.
5. Symlink-dependent files with explicit capability outcomes.
6. Native-path and subprocess-fixture regressions.
7. Cleanup-sensitive serial tests independently.
8. Supervisor and child-worker-supervisor families.
9. Each stalled file alone, then only evidence-driven ordered pairs.
10. `bun run typecheck`.
11. Relevant static verification scripts.

Every long-running invocation redirects stdout and stderr to a unique file before any inspection. The command’s own exit code is recorded directly.

## Completion criteria

The implementation is complete when:

- The unique bounded-runner behavior remains present on the master-based integration line.
- Master-integrated portability work is retained without duplicate implementations.
- Portable shell and Windows named-pipe IPC contracts have focused tests.
- Symlink tests run or skip according to the precise capability they require.
- Native assertions and subprocess fixtures no longer assume POSIX execution.
- Cleanup-sensitive tests release owned resources before deletion and preserve primary failures.
- Supervisor spawn failure settles, portable workers execute, and platform-impossible signal tests are explicit.
- Every original stalled chunk has an evidence-backed disposition from bounded tests.
- Focused suites, static guards, and typecheck pass, or any remaining failures are reported with full output and ownership.

The final report must not claim a complete Windows-suite pass because this design explicitly excludes another complete-suite run.
