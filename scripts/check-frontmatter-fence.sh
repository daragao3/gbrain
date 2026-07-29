#!/usr/bin/env bash
# CI guard: fail if any source file matches a YAML frontmatter fence with an
# LF-only `---\n` instead of the CRLF-tolerant `---\r?\n`.
#
# THE DEFECT. `content.match(/^---\n.../)` has no `m` flag, so `^` anchors at
# offset 0 only. A file that starts `---\r\n` therefore matches NOWHERE, and the
# parser returns null / `[]` — silently, with no error, no throw, no warning.
# Every downstream consumer sees "this file has no frontmatter" and falls back.
#
# WHY IT KEEPS COMING BACK. Three properties compound:
#   - On Windows `core.autocrlf=true` (the Git-for-Windows installer default)
#     makes EVERY checked-out SKILL.md CRLF, so it fires for the whole skills
#     tree at once, not for one unlucky file.
#   - It is an IDENTITY TRANSFORM on POSIX, so gbrain's ubuntu-only CI can never
#     surface it. A fully green CI run says nothing about this class.
#   - `.gitattributes` cannot fix it: `skillsDir` is a RUNTIME PARAMETER. gbrain
#     parses SKILL.md files it does not own and never checked out. The parsers
#     themselves must be tolerant.
# v0.42.68.1 fixed the fourth and fifth recurrence. This guard is the backstop.
# The invariant is stated in CLAUDE.md, "YAML frontmatter fences: never LF-only".
#
# WHAT IS FLAGGED — matcher shapes only, both anchored at offset 0 (the anchor
# is what makes the failure silent and total rather than partial):
#   1. an LF-only fence inside a regex literal:  /^---\n...
#   2. the method form:                          .startsWith('---\n')
#
# WHAT IS NOT FLAGGED:
#   - DATA construction. `---\n` appears in hundreds of fixture bodies, page
#     builders (``---\n${fm}\n---\n``) and markdown-HR joins
#     (`.join('\n\n---\n\n')`). None of those parse anything, and none carry a
#     `^` anchor or `startsWith`, so they are excluded structurally rather than
#     by allowlist. That distinction is the whole reason this guard keys on the
#     matcher and not on the fence literal.
#   - a match preceded (within NORMWIN lines, same file) by a CRLF normalize
#     such as `content.replace(/\r\n/g, '\n')`. Normalizing first is the OTHER
#     correct fix, and is preferred when the parsed VALUES flow downstream since
#     it also keeps a trailing `\r` out of them. Three call sites in src/ use it.
#   - comments — line and block are stripped, so the four files whose doc
#     comments quote `^---\n` while EXPLAINING this rule do not trip it.
#   - an explicit `frontmatter-fence-guard-ok` marker, either trailing the
#     flagged line or anywhere in the comment block directly above it. The
#     second form exists so an opt-out can state its REASON. Its real users are
#     assertions on gbrain's OWN emitted markdown (the serializer, the
#     frontmatter writer), where LF is the property under test and relaxing the
#     fence would stop the test catching a CRLF regression in the writer.
#
# DELIBERATELY OUT OF SCOPE: `indexOf('---\n')` and other unanchored closing-
# fence probes. They are CRLF-fragile too, but they fail partially rather than
# silently and total, and legitimate uses exist (locating the CLOSING fence at a
# known offset). Widening to them would trade this guard's precision for noise.
#
# Heuristic by design: a line-oriented scan, not a parser. String literals are
# not distinguished from code. The behavioral backstop is the CRLF round-trip
# assertions in the frontmatter parser tests, which fail against an LF-only
# fence on Windows.
#
# Usage:
#   bash scripts/check-frontmatter-fence.sh            # scan src/ and test/
#   bash scripts/check-frontmatter-fence.sh DIR [DIR…] # scan explicit dirs
#
# Exit: 0 when clean, 1 when violations found.

set -uo pipefail

# How many lines a `\r\n` normalize reaches forward to satisfy a later LF-only
# fence. The three in-tree normalize-first sites all sit at distance 1
# (normalize on line N, match on N+1); 8 absorbs an intervening comment block
# without letting an unrelated normalize elsewhere in the function launder a
# genuine violation.
NORMWIN=8

IN_GIT=0
SCAN_DIRS=("$@")
if [ "$#" -eq 0 ]; then
  # One rev-parse serves double duty: the repo root to scan from, and the
  # "is this a git checkout" signal that picks the file-listing strategy.
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$ROOT" ]; then
    IN_GIT=1
  else
    ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  fi
  cd "$ROOT" || exit 1
  SCAN_DIRS=(src test)
fi

SRC_EXT_RE='\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$'
SKIP_RE='(^|/)(node_modules|dist|build|coverage|\.next|\.git)/|\.min\.js$'

# File-level prefilter. Every violation contains the literal `---\n` (three
# dashes, backslash, n), so narrowing on it is sound. It also matches all the
# DATA uses — that is fine and intended: this only has to cut ~2k source files
# down to something awk can read quickly. awk is the precision layer.
PROBE='---\\n'

list_files() {
  if [ "$IN_GIT" = 1 ]; then
    # --untracked so a not-yet-added file is still gated locally; .gitignore is
    # still honored, so node_modules stays out.
    git grep -lIE --untracked -e "$PROBE" -- "${SCAN_DIRS[@]}" 2>/dev/null |
      grep -E "$SRC_EXT_RE" | grep -vE "$SKIP_RE" || true
  else
    # Explicit roots (the guard's own test points this at fixture dirs that are
    # not git repos), or a non-git checkout: plain find + grep.
    local cand
    cand="$(find "${SCAN_DIRS[@]}" -type f 2>/dev/null | grep -E "$SRC_EXT_RE" | grep -vE "$SKIP_RE")"
    [ -n "$cand" ] || return 0
    # `-e` is REQUIRED, not stylistic: PROBE starts with `---`, which grep parses
    # as an option otherwise ("unknown option -- -\n") and then matches nothing —
    # a guard that silently passes. Same reason the git path above uses `-e`.
    printf '%s\n' "$cand" | tr '\n' '\0' | xargs -0 grep -lE -e "$PROBE" 2>/dev/null || true
  fi
}

read -r -d '' AWK_PROG <<'AWK_EOF'
# Blank out comments so the doc comments that DOCUMENT this rule don't trip it.
# Scheme separators are neutralized first so `https://x` is not mistaken for the
# start of a line comment.
function strip(s,   i, j, t) {
  gsub(/:\/\//, ":\001\001", s)
  if (inblock) {
    i = index(s, "*/")
    if (i == 0) return ""
    inblock = 0
    s = substr(s, i + 2)
  }
  while ((i = index(s, "/*")) > 0) {
    t = substr(s, i + 2)
    j = index(t, "*/")
    if (j == 0) { s = substr(s, 1, i - 1); inblock = 1; break }
    s = substr(s, 1, i - 1) " " substr(s, i + j + 3)
  }
  i = index(s, "//")
  if (i > 0) s = substr(s, 1, i - 1)
  return s
}

function unprot(s) { gsub(/:\001\001/, "://", s); return s }
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }

function report(f, l, t, why,   txt) {
  txt = trim(unprot(t))
  if (length(txt) > 140) txt = substr(txt, 1, 137) "..."
  printf "  %s:%d\n      %s\n      %s\n", f, l, txt, why
}

# normline starts far enough back that line 1 can never be considered "recently
# normalized" (FNR - normline <= NORMWIN must be false at FNR == 1).
FNR == 1 { inblock = 0; normline = -1000; optout = 0 }

{
  # Opt-out marker: honored on the flagged line itself OR anywhere in the
  # comment block immediately above it. The preceding-comment form matters
  # because a good opt-out states a REASON, and a reason rarely fits in a
  # trailing comment. `optout` is cleared by the next line carrying real code
  # (below), so it can never leak past the statement it annotates.
  if ($0 ~ /frontmatter-fence-guard-ok/) optout = 1
  code = strip($0)

  # A CRLF normalize satisfies a following LF-only fence. Detected on the
  # comment-STRIPPED text so prose about normalizing can't launder a violation.
  if (code ~ /replace[ \t]*\(/ && code ~ /\\r/) normline = FNR

  why = ""
  if (code ~ /\^---\\n/)
    why = "LF-only fence in an offset-0 anchored regex: /^---\\n/ matches NOWHERE in a file that starts ---\\r\\n"
  else if (code ~ /startsWith[ \t]*\([ \t]*['"`]---\\n/)
    why = "startsWith('---\\n') is an offset-0 test and is false for every file that starts ---\\r\\n"

  if (why != "" && !optout && FNR - normline > NORMWIN)
    report(FILENAME, FNR, code, why)

  # Any line carrying real code closes the annotation window. Comment-only and
  # blank lines keep it open so a marker can sit above the statement it covers.
  if (code ~ /[^ \t]/) optout = 0
}
AWK_EOF

LIST="$(list_files)"

if [ -z "$LIST" ]; then
  echo "check-frontmatter-fence: ok (no candidate files)"
  exit 0
fi

OUT="$(printf '%s\n' "$LIST" | tr '\n' '\0' | xargs -0 awk -v NORMWIN="$NORMWIN" "$AWK_PROG" || true)"

if [ -n "$OUT" ]; then
  {
    echo "ERROR: LF-only YAML frontmatter fence (never matches a CRLF file):"
    echo
    echo "$OUT"
    echo "Relax the fence to be CRLF-tolerant — this is the canonical form, from"
    echo "src/core/skill-frontmatter.ts:"
    echo
    echo "    const m = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/);"
    echo
    echo "Or normalize ONCE up front, which is preferred when the parsed VALUES"
    echo "flow downstream (it also keeps a trailing \\r out of them):"
    echo
    echo "    const normalized = content.replace(/\\r\\n/g, '\\n');"
    echo
    echo "Do NOT normalize when the function returns a BYTE OFFSET into the"
    echo "original text (e.g. splitFrontmatter in src/core/skillopt/apply-edits.ts,"
    echo "whose caller reassembles via text.slice(0, bodyStart)) — normalizing"
    echo "shifts every offset. Relax the fence there instead."
    echo
    echo "On Windows core.autocrlf=true makes every checked-out SKILL.md CRLF, and"
    echo "this is an identity transform on POSIX — so a green Linux CI run does"
    echo "NOT mean this works. .gitattributes cannot fix it either: skillsDir is a"
    echo "runtime parameter, so gbrain parses SKILL.md files it does not own."
    echo
    echo "If a flagged line genuinely must stay LF-only, append a"
    echo "'frontmatter-fence-guard-ok' comment to it with the reason."
  } >&2
  exit 1
fi

echo "check-frontmatter-fence: ok (no LF-only frontmatter fences; $(printf '%s\n' "$LIST" | wc -l | tr -d ' ') candidate file(s) scanned)"
