#!/usr/bin/env bash
# Engine-live paths use static imports by default. A line-level
# `engine-dynamic-import-ok` marker is required for a justified lazy import.
#
# Historical Windows runs associated imports on these paths with abrupt Bun
# test-process exits, but system-wide commit exhaustion remained a confound.
# This guard therefore enforces a reviewed engine-path hardening invariant; it
# does not claim every dynamic import deterministically crashes Windows.
#
# Usage:
#   bash scripts/check-engine-dynamic-import.sh
#   bash scripts/check-engine-dynamic-import.sh FILE [FILE...]

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
    while IFS= read -r hit; do
      [ -n "$hit" ] && OUT="$OUT  $f:$hit"$'\n'
    done <<< "$hits"
  fi
done

if [ -n "$OUT" ]; then
  {
    echo "ERROR: unreviewed dynamic import on an engine-live path:"
    echo
    printf '%s' "$OUT"
    echo
    echo "Prefer a static top-level import. If lazy loading is load-bearing,"
    echo "append 'engine-dynamic-import-ok' to that exact line and document"
    echo "the startup or soft-failure boundary that requires it."
  } >&2
  exit 1
fi

echo "check-engine-dynamic-import: ok ($SCANNED file(s) scanned)"
