#!/usr/bin/env bash
# CI guard: verify that bun --compile binaries ship with embedded tree-sitter
# WASMs and produce real semantic chunks (not recursive-fallback chunks).
#
# This is the #1 silent-failure mode for v0.19.0 code indexing. If the WASM
# import attributes regress or the asset path drifts, the compiled binary
# silently falls through to the recursive text chunker. Users see no error,
# just degraded chunking quality. This script catches that regression.
#
# Fails the build when:
#   - bun build --compile fails
#   - The resulting binary can't parse TypeScript
#   - Chunks come back without real symbol names (fallback signature)
#
# Runs as part of `bun test` via the package.json pre-test pipeline.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Build into a temp DIRECTORY rather than a temp FILE: `bun build --compile`
# appends `.exe` on Windows, so a pre-created extension-less mktemp file is
# left behind at 0 bytes while the real binary lands next to it. Executing
# the stub yielded empty output and tripped the "no symbol names (fallback
# chunks)" branch below — reporting a WASM-embedding regression on every
# Windows dev box when embedding was in fact working.
OUT_DIR="$(mktemp -d /tmp/gbrain-wasm-check.XXXXXX)"
trap 'rm -rf "$OUT_DIR"' EXIT
OUT_BIN="$OUT_DIR/gbrain-wasm-check"

# Build a minimal smoketest binary that imports the chunker. We compile this
# instead of the full gbrain CLI so the failure mode is laser-focused on
# chunker + WASM path resolution, not unrelated CLI wiring.
if ! bun build --compile --outfile "$OUT_BIN" scripts/chunker-smoketest.ts >"$OUT_DIR/build.log" 2>&1; then
  echo "[check-wasm-embedded] FAIL: 'bun build --compile' did not succeed." >&2
  echo "[check-wasm-embedded] Build log:" >&2
  cat "$OUT_DIR/build.log" >&2
  exit 1
fi

# Resolve whichever name the toolchain actually produced.
if [ -x "$OUT_BIN.exe" ]; then
  OUT_BIN="$OUT_BIN.exe"
elif [ ! -x "$OUT_BIN" ]; then
  echo "[check-wasm-embedded] FAIL: build reported success but no executable was produced at" >&2
  echo "[check-wasm-embedded]   $OUT_BIN (or $OUT_BIN.exe)" >&2
  echo "[check-wasm-embedded] Contents of build dir:" >&2
  ls -la "$OUT_DIR" >&2
  exit 1
fi

# Run it and capture JSON output.
OUTPUT="$("$OUT_BIN" 2>&1)"

# Distinguish "binary ran and produced fallback chunks" (a real regression)
# from "binary produced nothing at all" (a harness/toolchain problem). The
# assertions below only grep for presence, so without this an empty string
# masquerades as a chunking regression.
if [ -z "${OUTPUT//[[:space:]]/}" ]; then
  echo "[check-wasm-embedded] FAIL: compiled binary produced no output at all." >&2
  echo "[check-wasm-embedded] This is a harness/toolchain problem, not a chunking regression." >&2
  echo "[check-wasm-embedded] Binary: $OUT_BIN" >&2
  exit 1
fi

# Sanity: JSON parses and has expected shape.
# - has_symbol_names: at least one chunk carries a concrete symbol name
#   (proves tree-sitter AST extraction, not recursive-fallback chunks).
# - has_typescript_header: the structured header is emitted with the
#   correct language tag (proves the language map reached displayLang).
# - calculateScore by name: specific function that MUST appear as a
#   top-level semantic node. If it's missing, the chunker either fell
#   through to recursive or the TypeScript grammar didn't load.
if ! echo "$OUTPUT" | grep -q '"has_symbol_names": true'; then
  echo "[check-wasm-embedded] FAIL: compiled binary returned no symbol names (fallback chunks)." >&2
  echo "[check-wasm-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

if ! echo "$OUTPUT" | grep -q '"has_typescript_header": true'; then
  echo "[check-wasm-embedded] FAIL: chunk header missing TypeScript language tag." >&2
  echo "[check-wasm-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

if ! echo "$OUTPUT" | grep -q '"calculateScore"'; then
  echo "[check-wasm-embedded] FAIL: tree-sitter did not extract the calculateScore function symbol." >&2
  echo "[check-wasm-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

echo "[check-wasm-embedded] OK — compiled binary produced real semantic chunks."
