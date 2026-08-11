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
#
# Usage:
#   bash scripts/run-serial-tests.sh [--dry-run-list] [FILE...]
#
# With no positional FILE arguments, every *.serial.test.ts outside test/e2e/
# runs (the mode `bun run test:serial` and run-unit-parallel.sh use). With one
# or more FILE arguments, ONLY those files run — each must be an existing
# *.serial.test.ts path or the script exits 2. Paths are repo-relative
# (a leading `./` is stripped) so the per-file special cases below still match.

set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0
selected=()
while [ $# -gt 0 ]; do
  case "$1" in
    # --dry-run-list mirrors run-unit-shard.sh for inline checks/tests.
    --dry-run-list) DRY_RUN=1; shift ;;
    -*) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
    *) selected+=("${1#./}"); shift ;;
  esac
done

files=()
if [ "${#selected[@]}" -gt 0 ]; then
  # Explicit selection. Validate loudly: a silently-discarded path here is the
  # exact failure this argument support exists to prevent (the old script
  # ignored positional args and ran the whole ~95-file sweep instead).
  bad=0
  for f in "${selected[@]}"; do
    case "$f" in
      *.serial.test.ts) ;;
      *) echo "ERROR: not a *.serial.test.ts path: $f" >&2; bad=1; continue ;;
    esac
    if [ ! -f "$f" ]; then
      echo "ERROR: no such file: $f (paths are relative to the repo root)" >&2
      bad=1
      continue
    fi
    files+=("$f")
  done
  [ "$bad" -eq 0 ] || exit 2
else
  # Use while-read for portability to macOS bash 3.2 (no mapfile).
  while IFS= read -r f; do
    files+=("$f")
  done < <(find test -name '*.serial.test.ts' -not -path 'test/e2e/*' | sort)
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "[serial-tests] no *.serial.test.ts files found"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
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
  test_timeout=60000
  if [ "$f" = "test/pglite-snapshot-file-seeding.serial.test.ts" ]; then
    test_timeout=900000
    echo "[serial-tests] building PGLite snapshot fixture for $f"
    if ! bun run build:pglite-snapshot; then
      fail_count=$((fail_count + 1))
      failed_files+=("$f (fixture build)")
      continue
    fi
  fi
  if ! bun test --max-concurrency=1 --timeout="$test_timeout" "$f"; then
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
