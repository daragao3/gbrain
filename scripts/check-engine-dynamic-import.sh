#!/usr/bin/env bash
# CI guard for direct, unmarked `await import(...)` sites in the engine and
# migration implementation files audited after Windows `bun test` runs began
# disappearing before their summary block.
#
# This is a deliberately line-oriented check. It catches direct matching lines
# in the named files; it does NOT inspect transitive callees, build a call graph,
# or prove that a particular site executes while PGLite is live. Its job is to
# keep this small audited surface explicit while deeper Windows test-runner and
# retained-memory work continues.
#
# WHAT IS SCANNED:
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
    echo "ERROR: direct unmarked dynamic import in an audited engine file:"
    echo
    printf '%s' "$OUT"
    echo
    echo "Prefer a static top-level import. Check whether the module is already"
    echo "in the static graph or is a runtime leaf before assuming laziness helps."
    echo
    echo "If the lazy load is genuinely load-bearing, append an"
    echo "'engine-dynamic-import-ok' comment to the line and explain why."
    echo
    echo "This guard is line-oriented. It does not inspect transitive callees or"
    echo "prove that a matching site executes while PGLite is live."
  } >&2
  exit 1
fi

echo "check-engine-dynamic-import: ok ($SCANNED file(s) scanned)"
