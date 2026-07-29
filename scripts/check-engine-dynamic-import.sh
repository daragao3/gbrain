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
      awk '
        {
          original = $0
          code = $0

          while (length(code) > 0) {
            if (in_block_comment) {
              comment_end = index(code, "*/")
              if (comment_end == 0) {
                code = ""
                break
              }
              code = substr(code, comment_end + 2)
              in_block_comment = 0
              continue
            }

            line_comment = index(code, "//")
            open = index(code, "/*")
            if (line_comment > 0 && (open == 0 || line_comment < open)) {
              code = substr(code, 1, line_comment - 1)
              break
            }
            if (open == 0) break

            before = substr(code, 1, open - 1)
            after = substr(code, open + 2)
            comment_end = index(after, "*/")
            if (comment_end == 0) {
              code = before
              in_block_comment = 1
              break
            }
            code = before substr(after, comment_end + 2)
          }

          trimmed = code
          sub(/^[ \t]+/, "", trimmed)
          if (trimmed ~ /^\*/) next
          if (index(code, "await import(") == 0) next
          if (index(original, "engine-dynamic-import-ok") > 0) next
          print NR ":" original
        }
      ' || true
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
