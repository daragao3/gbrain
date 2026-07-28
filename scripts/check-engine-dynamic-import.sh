#!/usr/bin/env bash
# CI guard: fail if a new `await import(...)` lands on the PGLite-live path.
#
# A dynamic import issued from an async method WHILE the PGLite WASM instance
# is live takes the whole `bun test` process down on Windows with exit 127
# (`ERROR_PROC_NOT_FOUND` — a WASM/native load failure, NOT shell "command not
# found"). Bun dies BEFORE printing its summary block, so a single occurrence
# discards the pass/fail totals for EVERY file in that invocation: a 253-file
# shard reports `pass=0 fail=0 rc=127` and the suite cannot gate anything.
#
# The identical call under `bun run` always exits 0, which is why this only
# ever surfaces in the test runner — and CI is ubuntu-only, so Linux never
# surfaces it at all. That combination (invisible on CI, fatal on Windows) is
# what makes it a silent-reintroduction risk and why this guard exists.
#
# WHAT IS SCANNED (the files an engine method can reach while WASM is live):
#   - src/core/pglite-engine.ts   — the engine itself
#   - src/core/postgres-engine.ts — engine parity (CLAUDE.md invariant: a
#     change lands in both engines or neither)
#   - src/core/migrate.ts         — `runMigrations()` is called from
#     `initSchema()`, i.e. on every PGLite boot, with WASM already live
#
# WHAT IS NOT FLAGGED:
#   - comment lines (the doc comments that describe this very rule, including
#     the ones in the engines, must not trip it)
#   - any line carrying an explicit `engine-dynamic-import-ok` opt-out marker
#
# The opt-out exists because some dynamic imports are load-bearing. The known
# legitimate case is `./ai/gateway.ts` in both engines: its transitive closure
# is the whole `ai` SDK + 4 provider packages + zod, it is wrapped in a
# `try/catch` whose catch arm ("gateway not configured — use defaults") is
# load-bearing, and hoisting it would both balloon CLI cold-start and convert a
# caught soft-failure into a module-load-time hard failure.
#
# Before adding a new opt-out, prefer hoisting: check whether the module is
# already in the static graph (several were pure redundancy — `retry.ts` was
# already imported statically at the top of both engines) or is a runtime leaf,
# in which case hoisting costs nothing at startup.
#
# Usage:
#   bash scripts/check-engine-dynamic-import.sh              # default file set
#   bash scripts/check-engine-dynamic-import.sh FILE [FILE…] # explicit files
#
# Exit: 0 when clean, 1 when violations found.

set -uo pipefail

if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$ROOT" || exit 1
  FILES=(
    src/core/pglite-engine.ts
    src/core/postgres-engine.ts
    src/core/migrate.ts
  )
fi

OUT=""
SCANNED=0

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  SCANNED=$((SCANNED + 1))
  # Strip CR so a CRLF checkout (the Git-for-Windows default) can't defeat the
  # match, then drop comment lines and opt-out lines before looking for the
  # dynamic import.
  hits="$(
    sed 's/\r$//' "$f" |
      grep -n "await import(" |
      grep -v "engine-dynamic-import-ok" |
      awk -F: '{ line = $0; sub(/^[0-9]+:/, "", line);
                 sub(/^[ \t]+/, "", line);
                 if (line ~ /^(\/\/|\*|\/\*)/) next;
                 print }' || true
  )"
  if [ -n "$hits" ]; then
    while IFS= read -r h; do
      [ -n "$h" ] && OUT="$OUT  $f:$h"$'\n'
    done <<< "$hits"
  fi
done

if [ -n "$OUT" ]; then
  {
    echo "ERROR: dynamic import on the PGLite-live path:"
    echo
    printf '%s' "$OUT"
    echo
    echo "An 'await import(...)' issued from an async method while the PGLite"
    echo "WASM instance is live takes the whole 'bun test' process down on"
    echo "Windows with exit 127, BEFORE Bun prints its summary — discarding"
    echo "pass/fail totals for every file in that invocation."
    echo
    echo "Hoist it to a static top-level import. Most candidates cost nothing:"
    echo "check whether the module is already in the static graph, or is a"
    echo "runtime leaf (no imports of its own)."
    echo
    echo "If the lazy load is genuinely load-bearing for startup cost, append an"
    echo "'engine-dynamic-import-ok' comment to the line with the reason."
    echo
    echo "This is invisible on CI (ubuntu-only) and under 'bun run' (always"
    echo "exits 0). A green CI run does NOT mean this is safe on Windows."
  } >&2
  exit 1
fi

echo "check-engine-dynamic-import: ok ($SCANNED file(s) scanned)"
