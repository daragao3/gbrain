#!/usr/bin/env bash
# CI guard: fail if any non-serial unit test file violates intra-process
# isolation rules. The v0.26.4 parallel runner loads multiple test files
# into one bun process per shard; module-level state (env vars, PGLite
# engines, mock.module overrides) leaks across files in that process and
# silently flakes other tests.
#
# Rules enforced (non-serial unit test files only):
#  R1: no `process.env.X = ...`, `process.env['X'] = ...`,
#      `delete process.env.X`, `Object.assign(process.env, ...)`,
#      `Reflect.set(process.env, ...)` mutations. Use withEnv() helper or
#      rename the file to `*.serial.test.ts`.
#  R2: no `mock.module(...)` anywhere. Top-level module mocks affect every
#      other file in the same shard process. Rename to `*.serial.test.ts`.
#  R3: `new PGLiteEngine(` may only appear within ~50 lines following a
#      `beforeAll(` line. Engines created at module scope (or in describe
#      bodies) leak across files in the shard process.
#  R4: any file that creates `new PGLiteEngine(` must call `.disconnect(`
#      inside an `afterAll(` block. Without disconnect, engines leak across
#      file boundaries within a shard process.
#
# Scope:
#  - Recursively scans `test/**/*.test.ts`.
#  - Skips `*.serial.test.ts` entirely (the quarantine escape hatch).
#  - Skips `test/e2e/**` (E2E runs sequentially in its own runner; not in
#    the parallel pool).
#
# Allow-list:
#  Files in `scripts/check-test-isolation.allowlist` (one filename per
#  line, # comments allowed) are skipped. This exists because v0.26.7
#  ships the lint as a foundation; v0.26.8 (env sweep) and v0.26.9
#  (PGLite sweep) remove entries as files get fixed. New files MUST NOT
#  be added — the allow-list shrinks over time, never grows.
#
# Usage: scripts/check-test-isolation.sh [TARGET_DIR]
# Exit:  0 when clean, 1 when un-allow-listed violations found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

TARGET_DIR="${1:-test}"
ALLOWLIST_FILE="$ROOT/scripts/check-test-isolation.allowlist"

# Read allowlist (one filename per line, # comments allowed). Empty file
# is fine — every violation will fail. Cached into ALLOWLIST so the
# per-file check (~700 lookups per run) is one pure-bash `case` match.
ALLOWLIST=""
if [ -f "$ALLOWLIST_FILE" ]; then
  ALLOWLIST="$(grep -v '^[[:space:]]*#' "$ALLOWLIST_FILE" | grep -v '^[[:space:]]*$' || true)"
fi

is_allowlisted() {
  local f="$1"
  if [ -z "$ALLOWLIST" ]; then
    return 1
  fi
  # Use a pure-bash `case` whole-line match against the newline-delimited
  # allowlist instead of `echo | grep -qxF`. v0.41.8 CI flake (verify job
  # 77771356276): the grep pipe form occasionally failed to match the
  # first allowlist entry on Ubuntu 24.04 + bash 5 under
  # `bun run` + GNU `timeout` (couldn't reproduce on macOS bash 3.2 with
  # the same allowlist file content + lint script content + checkout
  # state). Pure-bash case is locale-free, pipe-free, subshell-free,
  # set-e-quirk-free, and ~100x faster on every call.
  case $'\n'"$ALLOWLIST"$'\n' in
    *$'\n'"$f"$'\n'*) return 0 ;;
  esac
  return 1
}

# Find non-serial unit test files (excluding test/e2e). Portable across
# bash 3.2 (macOS default) and bash 4+; no mapfile.
FILE_LIST="$(find "$TARGET_DIR" -name '*.test.ts' \
  -not -name '*.serial.test.ts' \
  -not -path "*/e2e/*" \
  -type f 2>/dev/null | sort)"

violations=0
file_count=0

# ---------------------------------------------------------------------------
# Scan every file in ONE awk pass.
#
# This used to be a bash loop spawning up to 6 `grep`/`awk` processes per
# file. Across ~1.2k non-serial unit tests that is ~6k process spawns; on
# Windows, where spawns are very expensive, the check ran for over ten
# minutes and blew the verify harness's per-check timeout. The rules are
# all line-local (R1, R2) or simple whole-file state (R3's distance from the
# last beforeAll, R4's presence flags), so a single pass expresses them
# directly.
#
# awk reads the file list itself rather than taking filenames as argv:
# ~1.2k paths overflow ARG_MAX on some systems, and this sidesteps xargs
# re-batching entirely. Files are visited in the same sorted order, and
# rules are evaluated per file in the same R1→R4 order, so the report is
# byte-identical to the per-file version.
#
# Protocol back to the shell (tab-separated, one record per line):
#   V<TAB>file<TAB>rule   start of a violation
#   L<TAB>lineno:content  a matching line for the preceding V
#   F<TAB>count           total files scanned
# Allow-list filtering and the 3-line detail cap stay in the shell, where
# the allow-list already lives.
# ---------------------------------------------------------------------------
FILE_LIST_TMP="$(mktemp)"
AWK_OUT_TMP="$(mktemp)"
trap 'rm -f "$FILE_LIST_TMP" "$AWK_OUT_TMP"' EXIT
printf '%s\n' "$FILE_LIST" > "$FILE_LIST_TMP"

awk -v LIST="$FILE_LIST_TMP" '
BEGIN {
  nfiles = 0
  while ((getline f < LIST) > 0) {
    if (f == "") continue
    nfiles++
    r1 = ""; r2 = ""; r3 = ""
    has_pglite = 0; has_afterall = 0; has_disconnect = 0
    lba = -1000
    n = 0
    while ((getline line < f) > 0) {
      n++
      # R1: env mutations.
      if (line ~ /process\.env\.[A-Za-z_][A-Za-z_0-9]*[[:space:]]*=[^=]/ ||
          line ~ /process\.env\[[^]]+\][[:space:]]*=[^=]/ ||
          line ~ /delete[[:space:]]+process\.env\./ ||
          line ~ /delete[[:space:]]+process\.env\[/ ||
          line ~ /Object\.assign[[:space:]]*\([[:space:]]*process\.env/ ||
          line ~ /Reflect\.set[[:space:]]*\([[:space:]]*process\.env/)
        r1 = r1 n ":" line "\n"
      # R2: mock.module() anywhere.
      if (line ~ /mock\.module[[:space:]]*\(/)
        r2 = r2 n ":" line "\n"
      # R3/R4 state.
      if (line ~ /beforeAll[[:space:]]*\(/) lba = n
      if (line ~ /new PGLiteEngine[[:space:]]*\(/) {
        has_pglite = 1
        if (n - lba > 50) r3 = r3 n ":" line "\n"
      }
      if (line ~ /afterAll[[:space:]]*\(/) has_afterall = 1
      if (line ~ /\.disconnect[[:space:]]*\(/) has_disconnect = 1
    }
    close(f)

    if (r1 != "") { print "V\t" f "\tR1"; emit(r1) }
    if (r2 != "") { print "V\t" f "\tR2"; emit(r2) }
    if (r3 != "") { print "V\t" f "\tR3"; emit(r3) }
    if (has_pglite && (!has_afterall || !has_disconnect)) print "V\t" f "\tR4"
  }
  close(LIST)
  print "F\t" nfiles
}
function emit(blob,   parts, i, m) {
  m = split(blob, parts, "\n")
  for (i = 1; i < m; i++) print "L\t" parts[i]
}
' > "$AWK_OUT_TMP"

detail_rule() {
  case "$1" in
    R1) echo "process.env mutation; use withEnv() or rename to *.serial.test.ts" ;;
    R2) echo "mock.module() leaks across files in the shard process; rename to *.serial.test.ts" ;;
    R3) echo "new PGLiteEngine(...) outside beforeAll() context (>50 lines); move into beforeAll" ;;
    R4) echo "creates PGLiteEngine but missing afterAll(() => engine.disconnect()); engine leaks across files in the shard process" ;;
  esac
}

skip_current=0
detail_shown=0
while IFS= read -r rec; do
  tag="${rec%%$'\t'*}"
  rest="${rec#*$'\t'}"
  case "$tag" in
    F)
      file_count="$rest"
      ;;
    V)
      f="${rest%%$'\t'*}"
      rule="${rest##*$'\t'}"
      detail_shown=0
      if is_allowlisted "$f"; then
        skip_current=1
        continue
      fi
      skip_current=0
      echo "ERROR: $f"
      echo "       rule $rule: $(detail_rule "$rule")"
      violations=$((violations + 1))
      ;;
    L)
      [ "$skip_current" -eq 1 ] && continue
      # Match the original `head -3` cap on detail lines.
      [ "$detail_shown" -ge 3 ] && continue
      detail_shown=$((detail_shown + 1))
      echo "         $rest"
      ;;
  esac
done < "$AWK_OUT_TMP"

if [ $violations -gt 0 ]; then
  echo
  echo "check-test-isolation: FAIL ($violations violation(s))"
  echo
  echo "Fix:"
  echo "  - For env mutations, use withEnv() from test/helpers/with-env.ts"
  echo "  - For mock.module(), rename to *.serial.test.ts (quarantine)"
  echo "  - For PGLiteEngine, follow the canonical pattern in"
  echo "    test/helpers/reset-pglite.ts JSDoc and CLAUDE.md."
  echo
  echo "Or, if this is a baseline file from before the lint shipped,"
  echo "add it to scripts/check-test-isolation.allowlist (with a TODO"
  echo "comment naming the sweep PR that will remove it)."
  exit 1
fi

echo "check-test-isolation: OK ($file_count non-serial unit files scanned)"
