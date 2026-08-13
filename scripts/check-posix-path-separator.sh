#!/usr/bin/env bash
# CI guard: fail if any file compares a NATIVE filesystem path against a
# hardcoded forward-slash literal.
#
# `path.join()` / `path.resolve()` / `realpathSync()` emit the PLATFORM
# separator. On win32 that is `\`, so every one of these comparisons is
# silently, permanently false:
#
#     child.startsWith(parent + '/')      // 'C:\r\f'.startsWith('C:\r/') → false
#     p.startsWith('/')                   // 'C:\x' is absolute, but not '/'-led
#     p.substring(0, p.lastIndexOf('/'))  // '' for a '\'-separated path
#
# Which way that breaks depends on how the caller reads the result:
#   - a containment check reading `true == inside` FAILS CLOSED — every
#     legitimate path is rejected and the function is dead on Windows;
#   - a check reading `true == reject` FAILS OPEN — the boundary never fires
#     and the traversal/overlap it was written to stop sails through;
#   - a hand-rolled dirname returns `''`, and `mkdirSync('')` throws ENOENT.
#
# All four are IDENTITY TRANSFORMS on POSIX, so ubuntu-only CI can never
# surface them. That is precisely why this guard exists: the sites fixed
# alongside it had been green on CI for their entire lifetime, and each was
# originally found by accident.
#
# WHAT IS FLAGGED:
#   1. `x.startsWith('/')`                       — absoluteness test → isAbsolute()
#   2. `x.startsWith(<expr> + '/')`              — containment test  → isPathWithin()
#   3. `(substring|slice)(0, x.lastIndexOf('/'))` — hand-rolled dirname → dirname()
#   4. `x.endsWith('/') ? x : x + '/'`           — "ensure trailing separator",
#      the same containment bug with the separator smuggled through a variable:
#          const prefix = root.endsWith('/') ? root : root + '/';
#          if (!real.startsWith(prefix)) …          // shape 2, one line later
#      Shape 2 alone cannot see this, and it is NOT hypothetical — it is the
#      spelling `isPathContained` and `skillpack/copy.ts` independently grew.
#
# Shape 3 deliberately matches ONLY the dirname form. The BASENAME form
# (`x.slice(x.lastIndexOf('/') + 1)`) is left alone: in this repo it is used
# exclusively on slugs, which are '/'-separated by definition on every
# platform.
#
# WHAT IS NOT FLAGGED:
#   - comments (line + block are stripped, so the prose documenting this very
#     rule doesn't trip it);
#   - any line carrying a `posix-path-guard-ok` marker, or sitting within 3
#     lines below one — so the marker can be a comment ABOVE the code with a
#     short rationale, which is where it reads best.
#
# LIMITATION (documented, not a bug): this is a line-oriented scan, not a
# parser. Shape 4 catches the ONE spelling that has actually recurred for the
# smuggled-separator case, but a separator laundered through some other
# variable still slips past — e.g. building it with `String.fromCharCode(47)`,
# or assigning it in a different function than the comparison. Routing
# containment through `isPathWithin()` is what structurally removes that class;
# the guard stops the direct spellings from coming back.
#
# Usage:
#   bash scripts/check-posix-path-separator.sh            # scan the git-tracked tree
#   bash scripts/check-posix-path-separator.sh DIR [DIR…] # scan explicit dirs (fixtures)
#
# Exit: 0 when clean, 1 when violations found.

set -uo pipefail

IN_GIT=0
if [ "$#" -eq 0 ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$ROOT" ]; then
    IN_GIT=1
  else
    ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  fi
  cd "$ROOT" || exit 1
fi

# Every violation shape names one of these three methods and either carries a
# `/` later on the same line or opens a call whose argument starts on the next
# line. This catches nested expressions and formatter-split arguments while
# still shrinking ~2k source files to a small candidate set for ONE awk pass.
# Per-file grep loops are avoided deliberately: process spawn is the dominant
# cost on Windows dev boxes (~1.5-2.5s each).
PROBE='(startsWith|endsWith|lastIndexOf)(.*\/|[ \t]*\([ \t]*$)'

list_files() {
  if [ "$IN_GIT" = 1 ]; then
    git grep -lzIE --untracked -e "$PROBE" -- \
      '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' 2>/dev/null || true
  else
    find "${@:-.}" -type f \
      \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \
         -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' \) \
      ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/build/*' \
      ! -path '*/coverage/*' ! -path '*/.next/*' ! -path '*/.git/*' \
      ! -name '*.min.js' -exec grep -lE -Z "$PROBE" {} + 2>/dev/null || true
  fi
}

filter_files() {
  while IFS= read -r -d '' file; do
    case "/$file" in
      */node_modules/*|*/dist/*|*/build/*|*/coverage/*|*/.next/*|*/.git/*|*.min.js) ;;
      *) printf '%s\0' "$file" ;;
    esac
  done
}

count_files() {
  local count=0 file
  while IFS= read -r -d '' file; do
    count=$((count + 1))
  done
  printf '%s' "$count"
}

read -r -d '' AWK_PROG <<'AWK_EOF'
# Blank out comments without mistaking comment-like text inside quoted strings
# or templates for syntax. This is a small lexer, not a TypeScript parser; it
# preserves string contents because the violation itself contains the string
# literal `'/'`. Escaped comment delimiters in regex literals are left alone.
function strip(s,   i, c, n, prev, out, esc) {
  out = ""
  esc = 0
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    n = i < length(s) ? substr(s, i + 1, 1) : ""
    prev = i > 1 ? substr(s, i - 1, 1) : ""

    if (inblock) {
      if (c == "*" && n == "/") { inblock = 0; i++; out = out "  " }
      else out = out " "
      continue
    }

    if (quote != "") {
      out = out c
      if (esc) { esc = 0; continue }
      if (c == "\\") { esc = 1; continue }
      if (c == quote) quote = ""
      continue
    }

    if (c == "\"" || c == "'" || c == "`") {
      quote = c
      out = out c
      continue
    }
    if (c == "/" && n == "*" && prev != "\\") {
      inblock = 1; i++; out = out "  "
      continue
    }
    if (c == "/" && n == "/" && prev != "\\") break
    out = out c
  }
  # Ordinary quoted strings cannot cross a physical line without escaping it;
  # templates can, so retain only a backtick quote state across records.
  if (quote != "`") quote = ""
  return out
}

function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }

function report(f, l, t, why, fix,   key, txt) {
  key = f ":" l
  if (key in seen) return
  seen[key] = 1
  txt = trim(t)
  if (length(txt) > 140) txt = substr(txt, 1, 137) "..."
  printf "  %s:%d\n      %s\n      %s\n      fix: %s\n", f, l, txt, why, fix
  found = 1
}

function check(t, lno) {
  # 2. containment: x.startsWith(<expr> + '/')  — checked before shape 1,
  #    which is the same call without the concatenation.
  if (t ~ /\.startsWith[ \t]*\(.*\+[ \t]*['"`]\/['"`][ \t]*\)/) {
    report(FILENAME, lno, t,
      "containment test against a '/'-terminated prefix; resolve()/realpathSync() emit '\\' on win32, so this is always false there",
      "isPathWithin(child, parent) from src/core/path-confine.ts")
    return
  }
  # 1. absoluteness: x.startsWith('/')
  if (t ~ /\.startsWith[ \t]*\([ \t]*['"`]\/['"`][ \t]*\)/) {
    report(FILENAME, lno, t,
      "absoluteness test against '/'; a win32 absolute path is 'C:\\...' and does not start with '/'",
      "isAbsolute() from 'path'")
    return
  }
  # 3. hand-rolled dirname: (substring|slice)(0, x.lastIndexOf('/'))
  if (t ~ /(substring|slice)[ \t]*\([ \t]*0[ \t]*,[^)]*lastIndexOf[ \t]*\([ \t]*['"`]\/['"`]/) {
    report(FILENAME, lno, t,
      "hand-rolled dirname via lastIndexOf('/'); returns '' for a '\\'-separated path, and mkdirSync('') throws ENOENT",
      "dirname() from 'path'")
    return
  }
  # 4. "ensure trailing separator" — shape 2 with the '/' held in a variable.
  if (t ~ /\.endsWith[ \t]*\([ \t]*['"`]\/['"`][ \t]*\)[ \t]*\?/ && t ~ /\+[ \t]*['"`]\/['"`]/) {
    report(FILENAME, lno, t,
      "builds a '/'-terminated prefix for a later containment test; on win32 the path it will be compared against is '\\'-separated, so that test never matches",
      "isPathWithin(child, parent) from src/core/path-confine.ts — drop the prefix variable entirely")
    return
  }
}

FNR == 1 { inblock = 0; prev = ""; prevline = 0; pending = ""; pendingline = 0; optout = 0 }

{
  # An opt-out must be a comment, not an arbitrary string literal. It suppresses
  # its own line and the next 3, so a rationale can sit ABOVE the code.
  marker = ($0 ~ /^[ \t]*(\/\/|\/\*|\*)[^\n]*posix-path-guard-ok/ ||
            $0 ~ /\/\/[^\n]*posix-path-guard-ok/)
  if (marker) { optout = FNR + 3; prev = ""; pending = ""; next }
  if (optout && FNR <= optout) { prev = ""; pending = ""; next }

  code = strip($0)

  # Accumulate formatter-split method calls until the slash-bearing argument
  # arrives. This is intentionally bounded to 6 lines so malformed source cannot
  # turn the rest of a file into one giant regex input.
  if (pending != "") {
    pending = pending " " code
    # Check after every appended line: a nested call may close before the outer
    # method, and a ternary may continue after endsWith() closes. Clear only at
    # the statement boundary (or the safety cap), not at the first `)`.
    check(pending, pendingline)
    if (pendinglines >= 6 || code ~ /;[ \t]*$/) {
      pending = ""; pendingline = 0; pendinglines = 0
    } else {
      pendinglines++
    }
  } else if (code ~ /\.(startsWith|lastIndexOf)[ \t]*\([ \t]*$/ ||
             code ~ /\.endsWith[ \t]*\([ \t]*['"`]\/['"`][ \t]*\)[ \t]*$/) {
    pending = code; pendingline = FNR; pendinglines = 1
  }

  # `foo` \n `.startsWith(...)` — a leading-dot line continues the previous one.
  if (code ~ /^[ \t]*\./ && prev != "") check(prev " " code, prevline)
  check(code, FNR)
  prev = code; prevline = FNR
}
AWK_EOF

CANDIDATES_FILE="${TMPDIR:-/tmp}/gbrain-posix-path-candidates.$$"
trap 'rm -f "$CANDIDATES_FILE"' EXIT HUP INT TERM
list_files "$@" | filter_files > "$CANDIDATES_FILE"

if [ ! -s "$CANDIDATES_FILE" ]; then
  echo "check-posix-path-separator: ok (no candidate files)"
  exit 0
fi

OUT="$(xargs -0 awk "$AWK_PROG" < "$CANDIDATES_FILE" || true)"

if [ -n "$OUT" ]; then
  {
    echo "ERROR: native filesystem path compared against a hardcoded '/' separator:"
    echo
    echo "$OUT"
    echo "path.join()/resolve()/realpathSync() emit the PLATFORM separator, so these"
    echo "comparisons are permanently false on Windows — fail-closed (every legitimate"
    echo "path rejected) or fail-open (the boundary never fires), depending on how the"
    echo "result is read. They are identity transforms on POSIX, so a green Linux CI"
    echo "run does NOT mean this works on Windows."
    echo
    echo "    import { isPathWithin } from 'src/core/path-confine.ts';"
    echo "    if (!isPathWithin(child, parent)) throw new Error('outside root');"
    echo
    echo "If a flagged line really does operate on a slug, a git-relative path, or"
    echo "another always-'/'-separated string (never a native path), append or place"
    echo "above it a 'posix-path-guard-ok' comment stating which."
  } >&2
  exit 1
fi

CANDIDATE_COUNT="$(count_files < "$CANDIDATES_FILE")"
echo "check-posix-path-separator: ok (no '/'-separator path comparisons; $CANDIDATE_COUNT candidate file(s) scanned)"
