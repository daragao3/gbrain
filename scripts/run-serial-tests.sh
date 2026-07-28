#!/usr/bin/env bash
# scripts/run-serial-tests.sh — run *.serial.test.ts files with --max-concurrency=1.
#
# Serial files are tests that share file-wide state (top-level mock.module,
# module-level singletons that intentionally cross test cases) and would race
# under intra-file concurrency. Discovered via filename suffix; no annotation
# inside the file is needed.
#
# Excluded by run-unit-shard.sh and run-unit-parallel.sh's parallel pass.
# Invoked separately by run-unit-parallel.sh after the parallel pass succeeds.

set -euo pipefail

# Resolve the script dir BEFORE cd'ing, so sourcing below is cd-independent.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Hard-fail on a missing helper rather than limping on without teardown.
PROC_TREE_LIB="$SCRIPT_DIR/lib/proc-tree.sh"
if [ ! -r "$PROC_TREE_LIB" ]; then
  echo "ERROR: missing required helper: $PROC_TREE_LIB" >&2
  exit 2
fi
# shellcheck source=scripts/lib/proc-tree.sh
. "$PROC_TREE_LIB"

# ──────────────────────────────────────────────────────────────────────────
# Process-tree teardown.
#
# The serial pass is the longest-lived leaf of `bun run test` and used to run
# completely unsupervised: no trap, and one *foreground* `bun test` per file.
# It leaked whole trees two independent ways, both observed in the wild:
#
#   1. SIGTERM/SIGINT reaped this shell but NOT the in-flight `bun test`.
#      Bash runs a foreground child in the same process group, so a
#      single-pid `kill` hits the shell only and the bun child runs on.
#   2. The orphan case: the parent died without signalling us at all, so no
#      trap could ever have fired. This script kept walking the file list for
#      hours, spawning a fresh bun per file. On 2026-07-28 nine such orphans
#      were found alive at once, every one with a dead parent pid, and they
#      accumulate across sessions.
#
# Fix: run each file's bun in the background so we stay responsive, track it,
# tear its whole tree down from a trap, and poll the watched parent so case 2
# self-terminates.
#
# Env knobs (escape hatches; no config surface by design):
#   GBRAIN_TEST_WATCH_PID        pid to treat as "the run" (default: $PPID).
#                                run-unit-parallel.sh passes its own pid so
#                                the watch survives intermediate subshells.
#   GBRAIN_TEST_NO_PARENT_WATCH  set to 1 to disable the watchdog entirely
#                                (for deliberate nohup/setsid detached runs).
#   GBRAIN_TEST_WATCH_INTERVAL   poll seconds (default 1).
# ──────────────────────────────────────────────────────────────────────────
WATCH_PID="${GBRAIN_TEST_WATCH_PID:-$PPID}"
# Spelled as `if` rather than `[ ... ] && VAR=`: under `set -e` a trailing
# false test as the last command of a list is an abort waiting to happen.
if [ "${GBRAIN_TEST_NO_PARENT_WATCH:-0}" = "1" ]; then
  WATCH_PID=""
fi
WATCH_INTERVAL="${GBRAIN_TEST_WATCH_INTERVAL:-1}"

# Validate the watch target ONCE, at startup, and fail safe.
#
# A pid we cannot observe is useless as a liveness signal and actively
# dangerous as a watchdog input. On Windows, `bun run test` hands its child
# bash a PPID of 1 — Cygwin cannot map a non-Cygwin parent into its process
# table — and `kill -0 1` fails there. A watchdog that trusted that would
# decide "the run is gone" microseconds after startup and abort every single
# run. If we cannot see the parent now, we never will, so disable the
# watchdog rather than act on it.
#
# This is why run-unit-parallel.sh passes GBRAIN_TEST_WATCH_PID explicitly:
# it is a real Cygwin pid, so the watch stays armed on the one hop that
# actually leaked.
if [ -n "$WATCH_PID" ]; then
  if [ "$WATCH_PID" -le 1 ] 2>/dev/null || ! proc_alive "$WATCH_PID"; then
    WATCH_PID=""
  fi
fi

CHILD_PID=""

cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ -n "$CHILD_PID" ]; then
    proc_terminate_tree "$CHILD_PID"
    CHILD_PID=""
  fi
  return "$rc"
}
trap cleanup EXIT
trap 'cleanup; exit 143' INT TERM HUP

# Use while-read for portability to macOS bash 3.2 (no mapfile).
files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find test -name '*.serial.test.ts' -not -path 'test/e2e/*' | sort)

if [ "${#files[@]}" -eq 0 ]; then
  echo "[serial-tests] no *.serial.test.ts files found"
  exit 0
fi

# --dry-run-list mirrors run-unit-shard.sh for inline checks/tests.
if [ "${1:-}" = "--dry-run-list" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

echo "[serial-tests] running ${#files[@]} file(s), one bun process per file"

# Each serial file gets its OWN bun process. `--max-concurrency=1` was not
# enough: files in the same process share the module registry, so a top-level
# `mock.module(...)` in one file leaks into the next file's imports
# (eval-takes-quality-runner mocks gateway.ts and the next file fails on
# `import { resetGateway }` because the mock factory didn't export it).
# Per-file processes give true isolation; cost is ~100ms startup × N files.
fail_count=0
failed_files=()
for f in "${files[@]}"; do
  # Backgrounded (not foreground) so this shell stays responsive between polls:
  # it has to notice both "child finished" and "the run that owns me is gone".
  bun test --max-concurrency=1 --timeout=60000 "$f" &
  CHILD_PID=$!

  rc=0
  while true; do
    if ! proc_alive "$CHILD_PID"; then
      # Bash reaps the exited child and remembers its status, so `wait` still
      # reports the real exit code here.
      if wait "$CHILD_PID"; then rc=0; else rc=$?; fi
      break
    fi
    if [ -n "$WATCH_PID" ] && ! proc_alive "$WATCH_PID"; then
      echo "" >&2
      echo "[serial-tests] watched run (pid $WATCH_PID) is gone — tearing down and aborting" >&2
      proc_terminate_tree "$CHILD_PID"
      CHILD_PID=""
      exit 143
    fi
    sleep "$WATCH_INTERVAL"
  done
  CHILD_PID=""

  if [ "$rc" -ne 0 ]; then
    fail_count=$((fail_count + 1))
    failed_files+=("$f")
  fi
done

if [ "$fail_count" -gt 0 ]; then
  echo "" >&2
  echo "[serial-tests] $fail_count file(s) failed:" >&2
  for f in "${failed_files[@]}"; do
    echo "  - $f" >&2
  done
  exit 1
fi
echo "[serial-tests] all ${#files[@]} file(s) passed"
