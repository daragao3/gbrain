#!/usr/bin/env bash
# v0.32.3 — CI guard for docs/eval/METRIC_GLOSSARY.md freshness.
#
# Mirrors the scripts/check-jsonb-pattern.sh / check-progress-to-stdout.sh
# discipline: regenerate the doc into a tmp file, diff against the committed
# version, fail the build if they drift.
#
# Run: bash scripts/check-eval-glossary-fresh.sh
# CI wires this through `bun run test` so PRs that bump the glossary module
# without regenerating the doc are caught before review.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMITTED="$REPO_ROOT/docs/eval/METRIC_GLOSSARY.md"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [ ! -f "$COMMITTED" ]; then
  echo "ERROR: $COMMITTED not found." >&2
  echo "Run: bun run scripts/generate-metric-glossary.ts" >&2
  exit 1
fi

# Regenerate into TMP without touching the committed file. We can't easily
# point the generator at a different path; trick it by redirecting cwd to
# a sandbox and post-comparing.
cd "$REPO_ROOT"
# Render directly via bun + a one-liner that exposes the module function.
bun -e "import { renderMetricGlossaryMarkdown } from './src/core/eval/metric-glossary.ts'; process.stdout.write(renderMetricGlossaryMarkdown());" > "$TMP"

# --strip-trailing-cr compares CONTENT, not line endings. Git stores this
# doc with LF and the generator emits LF, but a checkout with
# `core.autocrlf=true` (the Windows default) materialises the working-tree
# copy as CRLF. A raw byte-diff then reports all ~176 lines as drifted on
# every Windows dev box while CI stays green — a false positive that says
# "stale, regenerate" when the content is identical. Regenerating in
# response is a no-op at best; committing CRLF to satisfy it would break
# the same check everywhere else. Real content drift still fails, which is
# the behaviour this guard exists for. Supported by GNU and BSD diff alike.
if ! diff -q --strip-trailing-cr "$COMMITTED" "$TMP" >/dev/null 2>&1; then
  echo "ERROR: docs/eval/METRIC_GLOSSARY.md is stale." >&2
  echo "" >&2
  echo "Diff between committed and freshly-generated:" >&2
  echo "" >&2
  diff -u --strip-trailing-cr "$COMMITTED" "$TMP" >&2 || true
  echo "" >&2
  echo "To regenerate: bun run scripts/generate-metric-glossary.ts" >&2
  exit 1
fi

echo "✓ docs/eval/METRIC_GLOSSARY.md is fresh"
