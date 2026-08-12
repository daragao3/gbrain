#!/usr/bin/env bash
# scripts/run-unit-parallel.sh — fast unit-test loop, parallel fan-out.
#
# Spawns N parallel `bun test` processes, each running a hash-disjoint shard
# of the unit-test set (files only — no e2e, no .slow, no .serial). After
# all shards complete, runs serial-only files (*.serial.test.ts) with
# --max-concurrency=1. Failure-first logging: extracts failure blocks from
# each shard's log, writes to .context/test-failures.log with --- shard $i:
# prefixes, prints loud stderr banner if any failures, exit non-zero.
#
# Usage:
#   bash scripts/run-unit-parallel.sh [--shards N] [--max-concurrency N] [--dry-run]
#
# Env overrides:
#   SHARDS=N                     same as --shards
#   GBRAIN_TEST_SHARD_TIMEOUT       per-shard wallclock cap, seconds (default 1500;
#                                   Windows single-shard default scales by file count)
#   GBRAIN_TEST_SHARD_STALL_SECONDS kill a shard whose log stops growing (default 600;
#                                   0 disables)
#   GBRAIN_TEST_MAX_CONCURRENCY     passed through to bun test (default 4)
#
# Output files (workspace-local; falls back to /tmp if .context/ unwritable):
#   .context/test-failures.log   failure blocks (cleared at start)
#   .context/test-summary.txt    per-shard pass/fail/skip/duration (cleared at start)
#   .context/test-shards/        per-shard logs + exit codes (cleared at start)

set -uo pipefail

cd "$(dirname "$0")/.."

# ──────────────────────────────────────────────────────────────────────────
# CPU detection: Apple Silicon perf cores → Mac total physical → nproc → 4.
# Returns a single positive integer.
# ──────────────────────────────────────────────────────────────────────────
detect_cpus() {
  local n=""
  n=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null) && [ -n "$n" ] && [ "$n" -gt 0 ] && echo "$n" && return
  n=$(sysctl -n hw.physicalcpu 2>/dev/null) && [ -n "$n" ] && [ "$n" -gt 0 ] && echo "$n" && return
  n=$(nproc 2>/dev/null) && [ -n "$n" ] && [ "$n" -gt 0 ] && echo "$n" && return
  echo 4
}

# ──────────────────────────────────────────────────────────────────────────
# Argument parsing. --shards N override wins over $SHARDS; both are clamped.
# ──────────────────────────────────────────────────────────────────────────
SHARDS_OVERRIDE=""
MAX_CONCURRENCY_OVERRIDE=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --shards) SHARDS_OVERRIDE="$2"; shift 2 ;;
    --shards=*) SHARDS_OVERRIDE="${1#*=}"; shift ;;
    --max-concurrency) MAX_CONCURRENCY_OVERRIDE="$2"; shift 2 ;;
    --max-concurrency=*) MAX_CONCURRENCY_OVERRIDE="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

N="${SHARDS_OVERRIDE:-${SHARDS:-$(detect_cpus)}}"
BUN_PLATFORM=$(bun -e 'process.stdout.write(process.platform)' 2>/dev/null || true)
WINDOWS_DEFAULT=0
if [ -z "${SHARDS_OVERRIDE:-}" ] && [ -z "${SHARDS:-}" ]; then
  case "$BUN_PLATFORM:$(uname -s 2>/dev/null)" in
    win32:*|*:MINGW*|*:MSYS*|*:CYGWIN*) N=1; WINDOWS_DEFAULT=1 ;;
  esac
fi
if ! printf '%s' "$N" | grep -qE '^[0-9]+$' || [ "$N" -lt 1 ]; then
  echo "ERROR: invalid shard count: $N" >&2; exit 2
fi
# v0.40.10 flake-hardening: clamp default to 4 (was 8) to match CI's
# test-shard.sh fan-out. At 8-shard parallel on Apple Silicon we observed
# shard 5 SIGKILL during source-health.test.ts's PGLite migration replay —
# 8 parallel PGLite WASM inits contend severely on the lockfile, and the
# 92-migration replay × 8 simultaneous can wedge past even 900s. CI uses
# 4 and is stable. Trade ~2x wallclock for reliability + parity with CI's
# fan-out. Override via --shards N or SHARDS=N (still capped at 8).
[ "$N" -gt 8 ] && N=8
if [ -z "${SHARDS_OVERRIDE:-}" ] && [ -z "${SHARDS:-}" ] && [ "$N" -gt 4 ]; then
  N=4
fi

INTRA_CONC="${MAX_CONCURRENCY_OVERRIDE:-${GBRAIN_TEST_MAX_CONCURRENCY:-4}}"
# POSIX keeps the established 1500s cap. The Windows default uses one shard to
# bound aggregate PGlite/WASM commit charge, so that shard owns the full file
# set and needs a cap that grows with it. Thirty seconds per file is the vetted
# Windows budget; the 1500s floor preserves behavior for smaller suites.
# Explicit shard counts retain the old cap unless GBRAIN_TEST_SHARD_TIMEOUT is
# set, because their concurrency/wallclock trade-off is user-selected.
SHARD_TIMEOUT_ORIGIN=""
if [ -n "${GBRAIN_TEST_SHARD_TIMEOUT:-}" ]; then
  SHARD_TIMEOUT="$GBRAIN_TEST_SHARD_TIMEOUT"
elif [ "$WINDOWS_DEFAULT" = "1" ]; then
  TOTAL_UNIT_FILES=$(SHARD= bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null | wc -l | tr -d ' ')
  SHARD_TIMEOUT=$((TOTAL_UNIT_FILES * 30))
  [ "$SHARD_TIMEOUT" -lt 1500 ] && SHARD_TIMEOUT=1500
  SHARD_TIMEOUT_ORIGIN=" (${TOTAL_UNIT_FILES} files/shard × 30s)"
else
  SHARD_TIMEOUT=1500
fi
if ! printf '%s' "$SHARD_TIMEOUT" | grep -qE '^[0-9]{1,9}$' || [ "$SHARD_TIMEOUT" -lt 1 ]; then
  echo "ERROR: invalid GBRAIN_TEST_SHARD_TIMEOUT: $SHARD_TIMEOUT" >&2; exit 2
fi
STALL_SECONDS="${GBRAIN_TEST_SHARD_STALL_SECONDS:-600}"
STALL_POLL_SECONDS="${GBRAIN_TEST_SHARD_STALL_POLL_SECONDS:-10}"
if ! printf '%s' "$STALL_SECONDS" | grep -qE '^[0-9]{1,9}$'; then
  echo "ERROR: invalid GBRAIN_TEST_SHARD_STALL_SECONDS: $STALL_SECONDS" >&2; exit 2
fi
if ! printf '%s' "$STALL_POLL_SECONDS" | grep -qE '^[0-9]{1,9}$' || [ "$STALL_POLL_SECONDS" -lt 1 ]; then
  echo "ERROR: invalid GBRAIN_TEST_SHARD_STALL_POLL_SECONDS: $STALL_POLL_SECONDS" >&2; exit 2
fi

# ──────────────────────────────────────────────────────────────────────────
# Output directories. Prefer workspace-local .context/. If it is unwritable,
# ask the host runtime for its native temp directory and keep every artifact
# beneath one PID-scoped run root so concurrent worktrees cannot collide.
# ──────────────────────────────────────────────────────────────────────────
LOG_DIR=""
if mkdir -p .context/test-shards 2>/dev/null; then
  LOG_DIR=".context/test-shards"
  FAILURES_LOG=".context/test-failures.log"
  SUMMARY_FILE=".context/test-summary.txt"
else
  # This script runs under Git Bash on Windows. Bun returns a native `C:\...`
  # path there; slash-normalize it so Bash/coreutils treat it as an absolute
  # drive path instead of a relative filename containing backslashes.
  HOST_TMP=$(bun -e 'process.stdout.write(require("node:os").tmpdir().replaceAll("\\\\", "/"))' 2>/dev/null || true)
  [ -n "$HOST_TMP" ] || { echo "ERROR: cannot resolve native temp directory" >&2; exit 2; }
  RUN_ROOT="$HOST_TMP/gbrain-test-run-$$"
  LOG_DIR="$RUN_ROOT/shards"
  FAILURES_LOG="$RUN_ROOT/failures.log"
  SUMMARY_FILE="$RUN_ROOT/summary.txt"
  mkdir -p "$LOG_DIR" || { echo "ERROR: cannot create log dir" >&2; exit 2; }
fi
# Clear from prior run.
rm -f "$LOG_DIR"/shard-*.log "$LOG_DIR"/shard-*.exit \
      "$LOG_DIR"/shard-*.wedged "$LOG_DIR"/shard-*.stalled \
      "$LOG_DIR"/shard-*.completed 2>/dev/null
: > "$FAILURES_LOG"
: > "$SUMMARY_FILE"

START_TS=$(date +%s)
if [ "$STALL_SECONDS" -gt 0 ]; then
  STALL_NOTE="stall=${STALL_SECONDS}s"
else
  STALL_NOTE="stall=off"
fi
echo "[unit-parallel] N=$N shards | --max-concurrency=$INTRA_CONC | timeout=${SHARD_TIMEOUT}s${SHARD_TIMEOUT_ORIGIN} | ${STALL_NOTE} | logs=$LOG_DIR" >&2

if [ "$DRY_RUN" = "1" ]; then
  echo "[unit-parallel] dry-run: would spawn $N shards with the above settings."
  for i in $(seq 1 "$N"); do
    SHARD="$i/$N" bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null \
      | sed "s|^|  [s$i] |"
  done
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────────
# Stall watchdog. The outer shard process may remain blocked after its Bun child
# disappears, so liveness is log growth rather than child-process presence.
# ──────────────────────────────────────────────────────────────────────────
child_pids() {
  local parent="$1" children
  if ps -eo pid=,ppid= >/dev/null 2>&1; then
    ps -eo pid=,ppid= 2>/dev/null | awk -v parent="$parent" '$2 == parent { print $1 }'
    return
  fi
  ps -W 2>/dev/null | awk -v parent="$parent" 'NR > 1 && $2 == parent { print $1 }'
}

kill_process_tree() {
  local pid="$1"
  local force_posix="${2:-0}"
  if [ "$force_posix" != "1" ] && [ "$BUN_PLATFORM" = "win32" ] && command -v taskkill.exe >/dev/null 2>&1; then
    local winpid
    winpid=$(ps -W 2>/dev/null | awk -v pid="$pid" '$1 == pid { print $4; exit }')
    if [ -n "$winpid" ]; then
      taskkill.exe //PID "$winpid" //T //F >/dev/null 2>&1 && return 0
      # taskkill can report failure when the targeted shell unwinds while its
      # descendants are being terminated. A now-absent root still means the
      # confirmed-live tree was successfully stopped.
      kill -0 "$pid" 2>/dev/null || return 0
      return 1
    fi
  fi
  local children child
  children=$(child_pids "$pid")
  for child in $children; do
    kill_process_tree "$child" 1
  done
  kill -KILL "$pid" 2>/dev/null && return 0
  kill -0 "$pid" 2>/dev/null || return 0
  return 1
}

# Helpers are shell pipelines owned by this wrapper. Stop their leaves first and
# give each parent a chance to reap its child before terminating the parent; this
# avoids leaking a sleep when pkill is absent and avoids touching unrelated PIDs.
stop_helper_branch() {
  local pid="$1" children child attempt
  children=$(child_pids "$pid")
  for child in $children; do
    stop_helper_branch "$child"
    attempt=0
    while kill -0 "$child" 2>/dev/null && [ "$attempt" -lt 20 ]; do
      sleep 0.05
      attempt=$((attempt + 1))
    done
  done
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null || true
}

stop_helper_tree() {
  local pid="$1" children child
  children=$(child_pids "$pid")
  for child in $children; do
    stop_helper_branch "$child"
  done
  # The helper may have advanced and spawned its next polling sleep while its
  # first child was reaped. Snapshot once more before stopping the owned root.
  children=$(child_pids "$pid")
  for child in $children; do
    stop_helper_branch "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

stall_watchdog() {
  local pid="$1" logf="$2" sentinel="$3"
  [ "$STALL_SECONDS" -gt 0 ] || return 0
  local last_size=-1 last_change size now
  last_change=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$STALL_POLL_SECONDS"
    kill -0 "$pid" 2>/dev/null || return 0
    size=$(wc -c < "$logf" 2>/dev/null | tr -d ' ')
    size="${size:-0}"
    now=$(date +%s)
    if [ "$size" != "$last_size" ]; then
      last_size="$size"
      last_change="$now"
    elif [ $((now - last_change)) -ge "$STALL_SECONDS" ]; then
      # Recheck immediately before recording the stall. On Windows/MSYS,
      # taskkill /T may terminate this watchdog along with the native shard
      # tree, so the marker must exist before termination begins. If the
      # watcher survives a definitive kill failure, remove the pending marker.
      kill -0 "$pid" 2>/dev/null || return 0
      echo "STALLED" > "$sentinel"
      kill_process_tree "$pid" || rm -f "$sentinel"
      return 0
    fi
  done
}

# ──────────────────────────────────────────────────────────────────────────
# Spawn shards. Each child captures its own exit code into a sentinel file
# so $? is recoverable per-shard (we never trust `wait`'s aggregate value).
# ──────────────────────────────────────────────────────────────────────────
SHARD_PIDS=()
for i in $(seq 1 "$N"); do
  (
    SHARD_LOG="$LOG_DIR/shard-$i.log"
    : > "$SHARD_LOG"
    env SHARD="$i/$N" \
      GBRAIN_TEST_SHARD_COMPLETED_FILE="$LOG_DIR/shard-$i.completed" \
      bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
      > "$SHARD_LOG" 2>&1 &
    run_pid=$!
    ( sleep "$SHARD_TIMEOUT" && echo "WEDGED" > "$LOG_DIR/shard-$i.wedged" && \
      kill_process_tree "$run_pid" ) &
    cap_pid=$!

    stall_watchdog "$run_pid" "$SHARD_LOG" "$LOG_DIR/shard-$i.stalled" &
    watchdog_pid=$!
    wait "$run_pid" 2>/dev/null
    rc=$?
    for helper in "$watchdog_pid" "$cap_pid"; do
      [ -n "$helper" ] || continue
      stop_helper_tree "$helper"
      wait "$helper" 2>/dev/null
    done

    # Helper evidence is fail-closed even when the shard wrote its private
    # completion marker: a deadline can kill the shell in the tiny interval
    # after marker creation but before exit and still yield rc=0 on Git Bash.
    # Nested test processes cannot forge the marker, but neither can the marker
    # prove that no owned helper actually terminated the shard.
    echo "$rc" > "$LOG_DIR/shard-$i.exit"
  ) &
  SHARD_PIDS+=($!)
done

# ──────────────────────────────────────────────────────────────────────────
# Heartbeat: every 10s, print per-shard progress to stderr by tailing logs
# and counting Bun's `(pass)` / `(fail)` / `(skip)` markers. Read-only.
# ──────────────────────────────────────────────────────────────────────────
# grep_count: returns 0 (single integer) if file is missing or zero matches,
# otherwise the match count. Avoids the `grep -c | echo 0` double-output bug
# where 0 matches produces a 2-line "0\n0" string that breaks arithmetic.
grep_count() {
  local pattern="$1"; local file="$2"
  if [ ! -f "$file" ]; then echo 0; return; fi
  local n
  n=$(grep -cE "$pattern" "$file" 2>/dev/null) || n=0
  echo "${n:-0}"
}

# bun_summary_count: parses Bun's summary lines (one per `bun test` invocation
# inside a shard — there's only one when we pass an explicit file list).
# Looks for ` N pass` / ` N fail` / ` N skip` patterns and sums them across
# all summary blocks the shard emitted. `bun test` prints these near the end
# of its output. Format: leading whitespace + integer + space + label.
bun_summary_count() {
  local label="$1"; local file="$2"
  if [ ! -f "$file" ]; then echo 0; return; fi
  awk -v label="$label" '
    $1 ~ /^[0-9]+$/ && $2 == label { total += $1 }
    END { print total + 0 }
  ' "$file"
}

# shard_total_files: parse the "[unit-shard N/M] running X files" line that
# run-unit-shard.sh echoes before invoking bun test. Returns the file count
# the shard was given, or 0 if the line isn't there yet (shard still
# bootstrapping). Uses sed-then-grep so it's portable to macOS awk (BSD awk
# doesn't support `match($0, /re/, arr)` with the array sink — that's gawk-only).
shard_total_files() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  local n
  n=$(sed -n 's/^\[unit-shard [0-9][0-9]*\/[0-9][0-9]*\] running \([0-9][0-9]*\) files.*/\1/p' "$file" 2>/dev/null | head -1)
  echo "${n:-0}"
}

# shard_pglite_init_count: count "Schema version" lines as a proxy for "test
# files initialized so far." Each PGLite-using test file's beforeAll triggers
# one initSchema() which prints this. Undercounts because not every test file
# opens a PGLite engine, but it's the only real-time progress signal bun's
# default reporter leaves in the log (bun has no per-file progress markers,
# only a final shard-end summary).
shard_pglite_init_count() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  grep -cE 'Schema version [0-9]+ → [0-9]+' "$file" 2>/dev/null || echo 0
}

# log_size_kb: total stderr+stdout written by the shard so far. Strictly
# monotonic — useful as a "definitely alive" signal when other heuristics
# read 0 (e.g. very early in shard startup before initSchema fires).
log_size_kb() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  local b
  b=$(wc -c < "$file" 2>/dev/null | tr -d ' ')
  echo $(( ${b:-0} / 1024 ))
}

# fmt_elapsed: pretty-print seconds → "Mm:SS" or "SSs" for short.
fmt_elapsed() {
  local s=$1
  if [ "$s" -ge 60 ]; then
    printf '%dm%02ds' $((s / 60)) $((s % 60))
  else
    printf '%ds' "$s"
  fi
}

heartbeat() {
  local hb_start=$(date +%s)
  while true; do
    sleep 10
    local line=""
    local now; now=$(date +%s)
    local hb_elapsed=$((now - hb_start))
    for i in $(seq 1 "$N"); do
      if [ -f "$LOG_DIR/shard-$i.exit" ]; then
        local rc; rc=$(cat "$LOG_DIR/shard-$i.exit" 2>/dev/null || echo "?")
        local status="✓"
        [ "$rc" != "0" ] && status="✗"
        local f
        f=$(bun_summary_count "fail" "$LOG_DIR/shard-$i.log")
        local p
        p=$(bun_summary_count "pass" "$LOG_DIR/shard-$i.log")
        line="$line [s$i: done $status ${p}p ${f}f]"
      else
        local lf="$LOG_DIR/shard-$i.log"
        if [ -f "$lf" ]; then
          # Bun's default reporter has no per-file progress markers, only a
          # final shard-end summary, so we surface three complementary signals
          # mid-run: (1) PGLite initSchema() count as a "files started" proxy,
          # (2) total files this shard was assigned (from the runner banner),
          # (3) log size in KB as a strictly-monotonic liveness signal.
          local total; total=$(shard_total_files "$lf")
          local pglite; pglite=$(shard_pglite_init_count "$lf")
          local kb; kb=$(log_size_kb "$lf")
          local et; et=$(fmt_elapsed "$hb_elapsed")
          if [ "$total" -gt 0 ]; then
            line="$line [s$i: ~${pglite}/${total}f ${kb}KB ${et}]"
          else
            line="$line [s$i: starting ${kb}KB ${et}]"
          fi
        else
          line="$line [s$i: spawning]"
        fi
      fi
    done
    printf '[heartbeat] %s\n' "$line" >&2
  done
}
heartbeat &
HB_PID=$!
# The heartbeat is another helper tree owned by this wrapper. Stop its current
# sleep descendant before the heartbeat shell in both exit paths; this remains
# bounded to descendants of HB_PID and does not depend on pkill being installed.
trap 'stop_helper_tree "$HB_PID"; wait "$HB_PID" 2>/dev/null' EXIT

# Wait for every shard. Don't care about wait's exit code.
for pid in "${SHARD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

stop_helper_tree "$HB_PID"
wait "$HB_PID" 2>/dev/null
trap - EXIT

# ──────────────────────────────────────────────────────────────────────────
# Aggregate failures (single writer; serial; never concurrent).
# Bun failure block format: from `(fail) ...` line through next `(pass)`,
# `(skip)`, blank line, or `__bun_test_summary__` marker.
# ──────────────────────────────────────────────────────────────────────────
TOTAL_FAILURES=0
TOTAL_PASS=0
TOTAL_SKIP=0
TOTAL_RC=0
for i in $(seq 1 "$N"); do
  SHARD_LOG="$LOG_DIR/shard-$i.log"
  EXIT_FILE="$LOG_DIR/shard-$i.exit"
  WEDGED_FILE="$LOG_DIR/shard-$i.wedged"
  STALLED_FILE="$LOG_DIR/shard-$i.stalled"
  COMPLETED_FILE="$LOG_DIR/shard-$i.completed"
  rc=1
  [ -f "$EXIT_FILE" ] && rc=$(cat "$EXIT_FILE" 2>/dev/null || echo 1)

  pass_count=$(bun_summary_count "pass" "$SHARD_LOG")
  fail_count=$(bun_summary_count "fail" "$SHARD_LOG")
  skip_count=$(bun_summary_count "skip" "$SHARD_LOG")
  TOTAL_PASS=$((TOTAL_PASS + pass_count))
  TOTAL_FAILURES=$((TOTAL_FAILURES + fail_count))
  TOTAL_SKIP=$((TOTAL_SKIP + skip_count))

  if [ -f "$STALLED_FILE" ]; then
    TOTAL_RC=1
    {
      echo "--- shard $i: STALLED — no log output for ${STALL_SECONDS}s ---"
      [ -f "$SHARD_LOG" ] && tail -50 "$SHARD_LOG"
      echo ""
    } >> "$FAILURES_LOG"
    echo "shard $i/$N: STALLED after ${STALL_SECONDS}s with no output (rc=$rc)" >> "$SUMMARY_FILE"
    continue
  fi

  if [ -f "$WEDGED_FILE" ]; then
    TOTAL_RC=1
    {
      echo "--- shard $i: WEDGED after ${SHARD_TIMEOUT}s ---"
      [ -f "$SHARD_LOG" ] && tail -50 "$SHARD_LOG"
      echo ""
    } >> "$FAILURES_LOG"
    echo "shard $i/$N: WEDGED after ${SHARD_TIMEOUT}s (rc=$rc)" >> "$SUMMARY_FILE"
    continue
  fi

  if [ "$rc" = "0" ] && [ "$fail_count" -eq 0 ] && [ ! -f "$COMPLETED_FILE" ]; then
    TOTAL_RC=1
    {
      echo "--- shard $i: UNATTESTED — natural completion marker missing (rc=$rc) ---"
      [ -f "$SHARD_LOG" ] && cat "$SHARD_LOG"
      echo ""
    } >> "$FAILURES_LOG"
    echo "shard $i/$N: UNATTESTED — natural completion marker missing (rc=$rc)" >> "$SUMMARY_FILE"
    continue
  fi

  echo "shard $i/$N: pass=$pass_count fail=$fail_count skip=$skip_count rc=$rc" >> "$SUMMARY_FILE"

  if [ "$rc" != "0" ] || [ "$fail_count" -gt 0 ]; then
    TOTAL_RC=1
    if [ "$fail_count" -gt 0 ] && [ -f "$SHARD_LOG" ]; then
      # Extract each (fail) block: from `(fail)` line through next `(pass)`,
      # `(skip)`, blank line, or `__bun_test_summary__`. Single awk pass.
      awk -v shard="$i" '
        /^\(fail\) / { in_block=1; print "--- shard " shard ": " $0; next }
        in_block {
          if (/^\(pass\)/ || /^\(skip\)/ || /^[[:space:]]*$/ || /__bun_test_summary__/) { in_block=0; print ""; next }
          print $0
        }
      ' "$SHARD_LOG" >> "$FAILURES_LOG"
    elif [ -f "$SHARD_LOG" ]; then
      # Non-zero rc but no (fail) line found — extraction couldn't pinpoint.
      # Dump the full shard log so we never silently lose the failure cause.
      {
        echo "--- shard $i: rc=$rc, no (fail) markers — full log follows ---"
        cat "$SHARD_LOG"
        echo ""
      } >> "$FAILURES_LOG"
    fi
  fi
done

# ──────────────────────────────────────────────────────────────────────────
# Print each shard's full output to stdout (developer expects to scroll
# through it). Print summary file last for one-glance overview.
# ──────────────────────────────────────────────────────────────────────────
for i in $(seq 1 "$N"); do
  SHARD_LOG="$LOG_DIR/shard-$i.log"
  echo ""
  echo "════════════ shard $i/$N ════════════"
  [ -f "$SHARD_LOG" ] && cat "$SHARD_LOG"
done
echo ""
echo "════════════ summary ════════════"
cat "$SUMMARY_FILE"
echo ""

# ──────────────────────────────────────────────────────────────────────────
# Serial pass: any *.serial.test.ts files run after parallel pass.
# ──────────────────────────────────────────────────────────────────────────
SERIAL_RC=0
SERIAL_FILES_COUNT=0
SERIAL_FILES_COUNT=$(find test -name '*.serial.test.ts' -not -path 'test/e2e/*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$SERIAL_FILES_COUNT" -gt 0 ]; then
  echo "════════════ serial pass ($SERIAL_FILES_COUNT files) ════════════"
  bash scripts/run-serial-tests.sh > "$LOG_DIR/serial.log" 2>&1
  SERIAL_RC=$?
  cat "$LOG_DIR/serial.log"
  if [ "$SERIAL_RC" != "0" ]; then
    TOTAL_RC=1
    s_fail=$(bun_summary_count "fail" "$LOG_DIR/serial.log")
    TOTAL_FAILURES=$((TOTAL_FAILURES + s_fail))
    if [ "$s_fail" -gt 0 ]; then
      awk '
        /^\(fail\) / { in_block=1; print "--- shard serial: " $0; next }
        in_block {
          if (/^\(pass\)/ || /^\(skip\)/ || /^[[:space:]]*$/ || /__bun_test_summary__/) { in_block=0; print ""; next }
          print $0
        }
      ' "$LOG_DIR/serial.log" >> "$FAILURES_LOG"
    else
      {
        echo "--- shard serial: rc=$SERIAL_RC, no (fail) markers — full log follows ---"
        cat "$LOG_DIR/serial.log"
        echo ""
      } >> "$FAILURES_LOG"
    fi
    echo "serial: rc=$SERIAL_RC fail=$s_fail" >> "$SUMMARY_FILE"
  else
    s_pass=$(bun_summary_count "pass" "$LOG_DIR/serial.log")
    TOTAL_PASS=$((TOTAL_PASS + s_pass))
    echo "serial: pass=$s_pass rc=0" >> "$SUMMARY_FILE"
  fi
fi

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

# ──────────────────────────────────────────────────────────────────────────
# Loud banner if anything failed. To stderr so it survives `| head`/`| tail`.
# ──────────────────────────────────────────────────────────────────────────
if [ "$TOTAL_RC" != "0" ]; then
  ABS_FAIL=$(cd "$(dirname "$FAILURES_LOG")" && pwd)/$(basename "$FAILURES_LOG")
  {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "❌ $TOTAL_FAILURES TEST FAILURES — full details:"
    echo "   $ABS_FAIL"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    tail -30 "$FAILURES_LOG"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "[unit-parallel] elapsed=${ELAPSED}s | pass=$TOTAL_PASS fail=$TOTAL_FAILURES skip=$TOTAL_SKIP"
  } >&2
  exit 1
fi

echo "[unit-parallel] elapsed=${ELAPSED}s | pass=$TOTAL_PASS fail=$TOTAL_FAILURES skip=$TOTAL_SKIP" >&2
exit 0
