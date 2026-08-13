#!/usr/bin/env bash
# scripts/run-unit-shard.sh
#
# Runs the unit suite for a single shard. Excludes test/e2e/* (those are run
# by scripts/run-e2e.sh in the E2E phase). When SHARD=N/M is set, keeps every
# M-th file starting at index N (1-indexed); otherwise runs the full unit set.
#
# Used by scripts/ci-local.sh to fan 4 unit-shard workers in parallel inside
# the runner container, each pinned to its own postgres shard for the
# downstream E2E phase.
#
# Sequential bun processes within a shard (one bun test invocation with the
# shard's file list); parallel across shards (4 of these run concurrently).

set -euo pipefail

cd "$(dirname "$0")/.."

# --max-concurrency=N is forwarded to `bun test`. v0.26.4: invoked by
# run-unit-parallel.sh; safe to call without (defaults to bun's default cap).
MAX_CONC=""
DRY_RUN=0
PRINT_CHUNK_CAP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-concurrency) MAX_CONC="$2"; shift 2 ;;
    --max-concurrency=*) MAX_CONC="${1#*=}"; shift ;;
    --dry-run-list) DRY_RUN=1; shift ;;
    --print-chunk-cap) PRINT_CHUNK_CAP=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve the chunk size + per-chunk wallclock cap. Defined here (rather than
# inline at the call site) so `--print-chunk-cap` can answer without globbing
# the test tree: run-unit-parallel.sh asks THIS script for the effective cap
# so the two bounds it owns can be sized against it, instead of duplicating
# the constants and letting them drift.
#
# The cap is derived from the chunk SIZE, never fixed. It was a flat 300s for
# a 4-file chunk — a 75s-per-file budget. On Windows a single unit file that
# constructs one PGLite engine pays ~65s of cold initSchema() replay before
# its first assertion, and test/sync-monorepo.test.ts measures 389s alone on
# an idle box. So the flat cap killed healthy chunks: every chunk containing
# that file lost the pass/fail totals for all four of its files, every run,
# which reads exactly like the hang the cap exists to catch. 600s/file keeps
# a real hang bounded while clearing the slowest measured file with headroom
# for a loaded box. Override with GBRAIN_TEST_CHUNK_TIMEOUT.
compute_chunk_bounds() {
  default_chunk=0
  is_windows_bun=0
  windows_chunk_seconds_per_file="${GBRAIN_TEST_CHUNK_SECONDS_PER_FILE:-600}"
  # run-unit-parallel.sh hands this down (it already ran the probe), so the
  # extra --print-chunk-cap call it makes costs a bash spawn and not a Bun
  # startup. Unset — a direct invocation — falls back to probing.
  bun_platform="${GBRAIN_TEST_BUN_PLATFORM:-}"
  [ -n "$bun_platform" ] || \
    bun_platform=$(bun -e 'process.stdout.write(process.platform)' 2>/dev/null || true)
  case "$bun_platform:$(uname -s 2>/dev/null)" in
    win32:*|*:MINGW*|*:MSYS*|*:CYGWIN*) default_chunk=4; is_windows_bun=1 ;;
  esac
  CHUNK="${GBRAIN_TEST_CHUNK_SIZE:-$default_chunk}"
  if ! printf '%s' "$CHUNK" | grep -qE '^[0-9]{1,9}$'; then
    echo "ERROR: invalid GBRAIN_TEST_CHUNK_SIZE: $CHUNK" >&2; exit 2
  fi
  if ! printf '%s' "$windows_chunk_seconds_per_file" | grep -qE '^[0-9]{1,9}$'; then
    echo "ERROR: invalid GBRAIN_TEST_CHUNK_SECONDS_PER_FILE: $windows_chunk_seconds_per_file" >&2; exit 2
  fi
  # Derive from the EFFECTIVE chunk size, not the default one: raising
  # GBRAIN_TEST_CHUNK_SIZE without also raising the cap is what turns the cap
  # into a guaranteed kill.
  default_chunk_timeout=0
  if [ "$is_windows_bun" = "1" ]; then
    default_chunk_timeout=$((CHUNK * windows_chunk_seconds_per_file))
  fi
  CHUNK_TIMEOUT="${GBRAIN_TEST_CHUNK_TIMEOUT:-$default_chunk_timeout}"
  if ! printf '%s' "$CHUNK_TIMEOUT" | grep -qE '^[0-9]{1,9}$'; then
    echo "ERROR: invalid GBRAIN_TEST_CHUNK_TIMEOUT: $CHUNK_TIMEOUT" >&2; exit 2
  fi
}

if [ "$PRINT_CHUNK_CAP" = "1" ]; then
  compute_chunk_bounds
  printf '%s\n' "$CHUNK_TIMEOUT"
  exit 0
fi

# All non-E2E test files, sorted for deterministic shard splits.
# Tier 4: *.slow.test.ts is "always-slow" (cold-path correctness checks);
# *.serial.test.ts is "concurrency-unsafe" (file-wide shared state). Both
# are excluded from the fast loop. Slow runs via `bun run test:slow`; serial
# runs via scripts/run-serial-tests.sh after the parallel pass.
# Use while-read to stay portable to macOS bash 3.2 (no mapfile).
all_files=()
while IFS= read -r f; do
  all_files+=("$f")
done < <(find test -name '*.test.ts' -not -path 'test/e2e/*' -not -name '*.slow.test.ts' -not -name '*.serial.test.ts' | sort)

files=()
if [ -n "${SHARD:-}" ]; then
  shard_n=${SHARD%/*}
  shard_m=${SHARD#*/}
  if ! printf '%s' "$shard_n" | grep -qE '^[0-9]+$' || \
     ! printf '%s' "$shard_m" | grep -qE '^[0-9]+$' || \
     [ "$shard_n" -lt 1 ] || [ "$shard_m" -lt 1 ] || [ "$shard_n" -gt "$shard_m" ]; then
    echo "ERROR: invalid SHARD=$SHARD (expected N/M with 1<=N<=M, both integers)" >&2
    exit 1
  fi
  i=0
  for f in "${all_files[@]}"; do
    if [ $((i % shard_m + 1)) -eq "$shard_n" ]; then
      files+=("$f")
    fi
    i=$((i + 1))
  done
else
  files=("${all_files[@]}")
fi

# The parallel supervisor uses this marker to distinguish a naturally clean
# shard from a blocked shell that unwinds with rc=0 after forced tree cleanup.
# Remove stale state up front; write it only on the actual success exits below.
COMPLETED_FILE="${GBRAIN_TEST_SHARD_COMPLETED_FILE:-}"
[ -n "$COMPLETED_FILE" ] && rm -f "$COMPLETED_FILE"
# Keep the supervisor-owned attestation path private to this shell. Test files
# can spawn nested shard runners (and inherit the Bun process environment); if
# descendants saw this path they could forge the outer shard's completion
# marker before a later chunk fails.
unset GBRAIN_TEST_SHARD_COMPLETED_FILE
mark_completed() {
  [ -z "$COMPLETED_FILE" ] || : > "$COMPLETED_FILE"
}

if [ "${#files[@]}" -eq 0 ]; then
  echo "[unit-shard ${SHARD:-(unsharded)}] no files; exiting clean."
  mark_completed
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

echo "[unit-shard ${SHARD:-(unsharded)}] running ${#files[@]} files"

# ──────────────────────────────────────────────────────────────────────────
# Chunking. On Windows, `bun test` intermittently dies with Windows error 127
# (ERROR_PROC_NOT_FOUND — a WASM/native load failure) partway through a run
# that boots several PGLite instances. The process dies BEFORE printing its
# summary, so a single crash silently discards the pass/fail totals for every
# file in the invocation: a 253-file shard reports `pass=0 fail=0 rc=127` and
# the whole suite becomes ungateable.
#
# Splitting the file list into bounded chunks contains the blast radius to one
# chunk. run-unit-parallel.sh's bun_summary_count() already sums Bun's summary
# block across multiple `bun test` invocations per shard, so chunking needs no
# aggregator change. A crashed chunk is reported explicitly rather than
# silently zeroing the shard.
#
# Default: off for POSIX Bun (preserves CI behaviour exactly); bounded for
# Windows Bun. Detect the runtime, not the shell: WSL bash reports Linux even
# when `bun run` is executing bun.exe, which would otherwise disable chunking.
# Override with GBRAIN_TEST_CHUNK_SIZE=N (0 disables).
#
# The chunk CAP is derived from the chunk SIZE, never fixed. It was a flat
# 300s for a 4-file chunk — a 75s-per-file budget. On Windows a single unit
# file that constructs one PGLite engine pays ~65s of cold initSchema()
# replay before its first assertion, and test/sync-monorepo.test.ts measures
# 389s alone on an idle box. So the flat cap killed healthy chunks: every
# chunk containing that file lost the pass/fail totals for all four of its
# files, every run, which reads exactly like the hang it was meant to catch.
# 600s/file keeps a real hang bounded while clearing the slowest measured
# file with headroom for a loaded box. Override with GBRAIN_TEST_CHUNK_TIMEOUT.
compute_chunk_bounds

TIMEOUT_BIN=""
if [ "$CHUNK_TIMEOUT" -gt 0 ]; then
  if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
  elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
  else
    echo "ERROR: GBRAIN_TEST_CHUNK_TIMEOUT requires timeout or gtimeout" >&2
    exit 2
  fi
fi

run_bun() {
  bun_args=(test --timeout=60000)
  [ -n "$MAX_CONC" ] && bun_args+=(--max-concurrency="$MAX_CONC")
  if [ -n "$TIMEOUT_BIN" ]; then
    # GNU timeout first sends TERM, then force-kills the exact child command
    # after a bounded grace. Without --kill-after, a TERM-resistant Bun/native
    # descendant can outlive the advertised chunk cap indefinitely.
    #
    # NOT --preserve-status. That flag makes timeout exit with the *command's*
    # status instead of 124, so a capped chunk surfaced as 143 (bun died on
    # TERM — the spinning case) or 137 (bun needed the KILL — the blocked
    # case). report_chunk_failure below keys on 124/137, so the 143 shape
    # scored as an anonymous non-zero rc: the shard failed with no
    # "CHUNK N STALLED" line naming the files that ate the cap. Measured on
    # Windows Bun 1.3.11 against a synthetic spinner and a synthetic blocked
    # await: with the flag 143/137, without it 124 for both. Dropping it
    # loses nothing — timeout still passes a non-timed-out command's own
    # status through, so the rc=127 WASM-crash signal below still arrives.
    "$TIMEOUT_BIN" --kill-after=5s "${CHUNK_TIMEOUT}s" bun "${bun_args[@]}" "$@"
  else
    bun "${bun_args[@]}" "$@"
  fi
}

report_chunk_failure() {
  local rc="$1" chunk_no="$2"
  shift 2
  if [ "$rc" -eq 127 ]; then
    echo "[unit-shard ${SHARD:-(unsharded)}] CHUNK $chunk_no CRASHED (rc=127, totals lost) files:" >&2
    printf '    %s\n' "$@" >&2
  elif [ "$rc" -eq 124 ]; then
    echo "[unit-shard ${SHARD:-(unsharded)}] CHUNK $chunk_no STALLED after ${CHUNK_TIMEOUT}s (rc=124, totals lost) files:" >&2
    printf '    %s\n' "$@" >&2
  elif [ "$rc" -eq 137 ] || [ "$rc" -eq 143 ]; then
    # 137 = KILL, 143 = TERM. Both mean the chunk was stopped at the cap
    # rather than finishing. 143 is unreachable with the timeout invocation
    # above, but stays handled so a future --preserve-status (or a TERM from
    # the outer shard watchdog) can never go back to reporting anonymously.
    echo "[unit-shard ${SHARD:-(unsharded)}] CHUNK $chunk_no FORCE-KILLED after ${CHUNK_TIMEOUT}s + 5s grace (rc=$rc, totals lost) files:" >&2
    printf '    %s\n' "$@" >&2
  fi
}

if [ "$CHUNK" -eq 0 ]; then
  # Unchunked POSIX runs preserve the established direct-execution path.
  rc=0; run_bun "${files[@]}" || rc=$?
  [ "$rc" -ne 0 ] || mark_completed
  exit "$rc"
fi

worst=0
total=${#files[@]}
idx=0
chunk_no=0
while [ "$idx" -lt "$total" ]; do
  chunk_no=$((chunk_no + 1))
  batch=()
  n=0
  while [ "$idx" -lt "$total" ] && [ "$n" -lt "$CHUNK" ]; do
    batch+=("${files[$idx]}")
    idx=$((idx + 1)); n=$((n + 1))
  done
  echo "[unit-shard ${SHARD:-(unsharded)}] chunk $chunk_no: ${#batch[@]} files ($idx/$total)"
  rc=0; run_bun "${batch[@]}" || rc=$?
  if [ "$rc" -ne 0 ]; then
    # 127 here is the Bun/WASM crash described above, not "command not found":
    # the totals for this chunk are lost. Name the files so the run is still
    # actionable instead of silently under-reporting.
    report_chunk_failure "$rc" "$chunk_no" "${batch[@]}"
    [ "$rc" -gt "$worst" ] && worst=$rc
  fi
done
[ "$worst" -ne 0 ] || mark_completed
exit "$worst"
