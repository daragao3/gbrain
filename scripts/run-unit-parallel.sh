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
#   GBRAIN_TEST_SHARD_TIMEOUT    per-shard wallclock cap, seconds (default 600)
#   GBRAIN_TEST_MAX_CONCURRENCY  passed through to bun test (default 4)
#
# Output files (workspace-local; falls back to /tmp if .context/ unwritable):
#   .context/test-failures.log   failure blocks (cleared at start)
#   .context/test-summary.txt    per-shard pass/fail/skip/duration (cleared at start)
#   .context/test-shards/        per-shard logs + exit codes (cleared at start)

set -uo pipefail

# Resolve the script dir BEFORE cd'ing, so sourcing below is cd-independent.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# Hard-fail on a missing helper. This script runs under `set -uo pipefail`
# WITHOUT `-e`, so a failed `.` would otherwise be a warning on stderr and
# then a cascade of "command not found" as every teardown call silently did
# nothing — i.e. exactly the leak this file exists to prevent, reintroduced
# quietly. Copying the scripts somewhere without lib/ must be loud.
PROC_TREE_LIB="$SCRIPT_DIR/lib/proc-tree.sh"
if [ ! -r "$PROC_TREE_LIB" ]; then
  echo "ERROR: missing required helper: $PROC_TREE_LIB" >&2
  exit 2
fi
# shellcheck source=scripts/lib/proc-tree.sh
. "$PROC_TREE_LIB"

# ──────────────────────────────────────────────────────────────────────────
# Run-level teardown state.
#
# Killing the top-level `bun run test` only kills bun: this script is then an
# orphan but still very much ALIVE, so it walks on through the shards and into
# the serial pass. run-serial-tests.sh's own watchdog cannot save us there —
# its parent (us) is still running. Somebody has to notice the run itself is
# gone, and that somebody is this script.
#
# Env knobs mirror run-serial-tests.sh:
#   GBRAIN_TEST_WATCH_PID / GBRAIN_TEST_NO_PARENT_WATCH / GBRAIN_TEST_WATCH_INTERVAL
# ──────────────────────────────────────────────────────────────────────────
SELF_PID=$$
WATCH_PID="${GBRAIN_TEST_WATCH_PID:-$PPID}"
if [ "${GBRAIN_TEST_NO_PARENT_WATCH:-0}" = "1" ]; then
  WATCH_PID=""
fi
WATCH_INTERVAL="${GBRAIN_TEST_WATCH_INTERVAL:-2}"

# Fail safe on an unobservable parent — see the long note in
# run-serial-tests.sh. Short version: `bun run test` gives its child bash a
# PPID of 1 on Windows and `kill -0 1` fails there, so a watchdog that trusted
# $PPID would abort every run instantly. When the parent cannot be observed we
# disable the watchdog; the run is then still covered, because our EXIT/TERM
# trap tears the serial pass down when we die politely, and run-serial-tests.sh
# watches US (a real, observable pid) for the SIGKILL case.
if [ -n "$WATCH_PID" ]; then
  if [ "$WATCH_PID" -le 1 ] 2>/dev/null || ! proc_alive "$WATCH_PID"; then
    WATCH_PID=""
  fi
fi

SHARD_PIDS=()
SERIAL_PID=""
HB_PID=""
WATCHDOG_PID=""

# owned_pids: every pid this run is responsible for, as a flat list.
owned_pids() {
  if [ "${#SHARD_PIDS[@]}" -gt 0 ]; then
    printf '%s\n' "${SHARD_PIDS[@]}"
  fi
  printf '%s\n%s\n%s\n' "$SERIAL_PID" "$WATCHDOG_PID" "$HB_PID"
}

# teardown_children: reap everything this run owns. Safe to call repeatedly
# and from a trap; never changes the caller's exit status.
teardown_children() {
  # shellcheck disable=SC2046 — intentional word splitting of the pid list.
  set -- $(owned_pids)
  [ "$#" -gt 0 ] || return 0
  # Happy path: on a normal run every child has already exited. Bail out on a
  # builtin-only liveness check so the common case never pays for `ps`, which
  # costs 9-12 SECONDS on a loaded Windows box.
  proc_any_alive "$@" || return 0
  proc_kill_forest TERM "$@"
  local waited=0
  while [ "$waited" -lt 3 ]; do
    proc_any_alive "$@" || break
    sleep 1
    waited=$((waited + 1))
  done
  proc_kill_forest KILL "$@"
  return 0
}

cleanup_run() {
  local rc=$?
  trap - EXIT INT TERM HUP
  teardown_children
  return "$rc"
}
trap cleanup_run EXIT
trap 'cleanup_run; exit 143' INT TERM HUP

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
# v0.40.10 flake-hardening: bump per-shard cap 600 → 1500 (was 900). At
# 4-shard default each shard runs 159 files / ~2420 tests with internal
# wallclock 960-1020s. The 900s value (sized for 8-shard's ~80 files /
# 1100 tests at 620-770s) false-killed shard 1 at 900s even though it
# had completed in 968s. 1500s cap gives ~55% headroom over observed
# 4-shard wallclock; real hangs still hit it. Override via
# GBRAIN_TEST_SHARD_TIMEOUT=N.
SHARD_TIMEOUT="${GBRAIN_TEST_SHARD_TIMEOUT:-1500}"

# ──────────────────────────────────────────────────────────────────────────
# Output directories. Prefer workspace-local .context/, fall back to /tmp.
# ──────────────────────────────────────────────────────────────────────────
LOG_DIR=""
if mkdir -p .context/test-shards 2>/dev/null; then
  LOG_DIR=".context/test-shards"
  FAILURES_LOG=".context/test-failures.log"
  SUMMARY_FILE=".context/test-summary.txt"
else
  LOG_DIR="/tmp/gbrain-test-shards-$$"
  FAILURES_LOG="/tmp/gbrain-test-failures.log"
  SUMMARY_FILE="/tmp/gbrain-test-summary.txt"
  mkdir -p "$LOG_DIR" || { echo "ERROR: cannot create log dir" >&2; exit 2; }
fi
# Clear from prior run.
rm -f "$LOG_DIR"/shard-*.log "$LOG_DIR"/shard-*.exit "$LOG_DIR"/shard-*.wedged 2>/dev/null
: > "$FAILURES_LOG"
: > "$SUMMARY_FILE"

# ──────────────────────────────────────────────────────────────────────────
# Resolve `timeout` command. macOS without coreutils has neither; we degrade
# to bg-pid + sleep cap. For now, prefer gtimeout (brew coreutils) → timeout.
# ──────────────────────────────────────────────────────────────────────────
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
fi

START_TS=$(date +%s)
echo "[unit-parallel] N=$N shards | --max-concurrency=$INTRA_CONC | timeout=${SHARD_TIMEOUT}s | logs=$LOG_DIR | watchdog=${WATCH_PID:-off}" >&2

if [ "$DRY_RUN" = "1" ]; then
  echo "[unit-parallel] dry-run: would spawn $N shards with the above settings."
  for i in $(seq 1 "$N"); do
    SHARD="$i/$N" bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null \
      | sed "s|^|  [s$i] |"
  done
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────────
# Spawn shards. Each child captures its own exit code into a sentinel file
# so $? is recoverable per-shard (we never trust `wait`'s aggregate value).
# SHARD_PIDS is declared with the other teardown state at the top of the file
# so the EXIT trap can reap shards even if we die during the spawn loop.
# ──────────────────────────────────────────────────────────────────────────
for i in $(seq 1 "$N"); do
  (
    SHARD_LOG="$LOG_DIR/shard-$i.log"
    if [ -n "$TIMEOUT_BIN" ]; then
      "$TIMEOUT_BIN" "${SHARD_TIMEOUT}s" \
        env SHARD="$i/$N" \
        bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
        > "$SHARD_LOG" 2>&1
    else
      env SHARD="$i/$N" \
        bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
        > "$SHARD_LOG" 2>&1 &
      pid=$!
      ( sleep "$SHARD_TIMEOUT" && kill -TERM "$pid" 2>/dev/null && \
        sleep 5 && kill -KILL "$pid" 2>/dev/null ) &
      cap_pid=$!
      wait "$pid" 2>/dev/null
      kill "$cap_pid" 2>/dev/null
      wait "$cap_pid" 2>/dev/null
    fi
    rc=$?
    echo "$rc" > "$LOG_DIR/shard-$i.exit"
    [ "$rc" = "124" ] && echo "WEDGED" > "$LOG_DIR/shard-$i.wedged"
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
  local hb_sleep=""
  # Own the sleep so we can cancel it from a trap. A shell parked in a
  # FOREGROUND `sleep` does not forward SIGTERM to it: the shell dies, the
  # sleep reparents to init and lingers. That leaked exactly one orphan sleep
  # per invocation, which CI's end-of-job orphan sweep reported as unnamed
  # test failures. The previous defence was `pkill -P`, which does not exist
  # on Git-Bash/Cygwin — a silent no-op on the very platform that needed it.
  # Backgrounding the sleep and waiting on it makes the trap effective
  # everywhere, with no dependency on an external tool.
  trap 'kill "$hb_sleep" 2>/dev/null; exit 0' TERM INT
  while true; do
    sleep 10 &
    hb_sleep=$!
    wait "$hb_sleep" 2>/dev/null
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

# ──────────────────────────────────────────────────────────────────────────
# Parent watchdog. Killing `bun run test` kills bun and nothing else — this
# script survives as an orphan and keeps driving shards and (much worse) the
# serial pass, which spawns one fresh bun per file for dozens of files. Poll
# the pid that owns the run and tear the whole thing down when it goes away.
#
# The re-check after a short sleep is cheap insurance against a transient ps
# hiccup or a pid that is momentarily unsignalable, so we never abort a
# healthy run on a single bad sample.
# ──────────────────────────────────────────────────────────────────────────
parent_watchdog() {
  local wd_sleep=""
  # Same self-cancelling sleep as the heartbeat, for the same reason: a
  # foreground `sleep` would outlive this shell as an orphan.
  trap 'kill "$wd_sleep" 2>/dev/null; exit 0' TERM INT
  while true; do
    sleep "$WATCH_INTERVAL" &
    wd_sleep=$!
    wait "$wd_sleep" 2>/dev/null
    if ! proc_alive "$WATCH_PID"; then
      sleep 1
      if proc_alive "$WATCH_PID"; then continue; fi
      echo "" >&2
      echo "[unit-parallel] owning run (pid $WATCH_PID) is gone — aborting and tearing down" >&2
      kill -TERM "$SELF_PID" 2>/dev/null || true
      return 0
    fi
  done
}
if [ -n "$WATCH_PID" ]; then
  parent_watchdog &
  WATCHDOG_PID=$!
fi

# Wait for every shard. Don't care about wait's exit code.
for pid in "${SHARD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

# The heartbeat cancels its own sleep from its TERM trap (see above), so a
# plain builtin `kill` is enough and leaves nothing behind. Deliberately no
# `ps` sweep on this path: it runs on every successful run, and `ps -e` costs
# 9-12 seconds on a loaded Windows box.
kill -TERM "$HB_PID" 2>/dev/null
wait "$HB_PID" 2>/dev/null
HB_PID=""

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
  rc=1
  [ -f "$EXIT_FILE" ] && rc=$(cat "$EXIT_FILE" 2>/dev/null || echo 1)

  pass_count=$(bun_summary_count "pass" "$SHARD_LOG")
  fail_count=$(bun_summary_count "fail" "$SHARD_LOG")
  skip_count=$(bun_summary_count "skip" "$SHARD_LOG")
  TOTAL_PASS=$((TOTAL_PASS + pass_count))
  TOTAL_FAILURES=$((TOTAL_FAILURES + fail_count))
  TOTAL_SKIP=$((TOTAL_SKIP + skip_count))

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

  echo "shard $i/$N: pass=$pass_count fail=$fail_count skip=$skip_count rc=$rc" >> "$SUMMARY_FILE"

  if [ "$rc" != "0" ]; then
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
  # Supervised the same way the shards are: backgrounded, pid retained, reaped
  # children-first by the EXIT/TERM trap. Run synchronously via `wait` so the
  # trap can interrupt it — a foreground child would leave this shell blocked
  # in a syscall with its bun grandchild unreachable, which is how the serial
  # pass used to survive its own run being killed.
  #
  # GBRAIN_TEST_WATCH_PID pins the watch to *this* script rather than whatever
  # the child's $PPID happens to be, so intermediate subshells cannot mask a
  # dead run.
  GBRAIN_TEST_WATCH_PID="$SELF_PID" \
    bash scripts/run-serial-tests.sh > "$LOG_DIR/serial.log" 2>&1 &
  SERIAL_PID=$!
  wait "$SERIAL_PID" 2>/dev/null
  SERIAL_RC=$?
  SERIAL_PID=""
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

# Normal completion: retire the watchdog here, so by the time the EXIT trap
# runs nothing this script owns is still alive and teardown_children can
# short-circuit on its builtin liveness check. Leaving it running would make
# every successful run pay for a `ps` sweep it does not need.
if [ -n "$WATCHDOG_PID" ]; then
  kill -TERM "$WATCHDOG_PID" 2>/dev/null
  wait "$WATCHDOG_PID" 2>/dev/null
  WATCHDOG_PID=""
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
