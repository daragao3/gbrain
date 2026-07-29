#!/usr/bin/env bash
# CI guard: fail if any source file tests a FILESYSTEM directory boundary with a
# hardcoded forward slash — `child.startsWith(parent + '/')` and friends.
#
# On Windows `resolve()`, `realpathSync()` and `join()` all emit `\`, so a
# hardcoded `/` can never match at the boundary and the comparison is pinned to
# `false` forever. Which way that breaks depends on the surrounding polarity, and
# BOTH directions are bad:
#
#   - an ALLOW fence (`if (!inside) throw`) becomes a permanent throw — the
#     feature is dead. `gbrain sync` rejected every file in the repo as a
#     "symlink escape"; LocalStorage threw on every upload/download.
#   - a DENY fence (`if (inside) refuse`) becomes a permanent pass — a leak. The
#     source-overlap check accepted nested sources, the inbox watcher stopped
#     ignoring its own archive directory, and the integrations installer would
#     write into a parent of gbrain's own checkout.
#
# It is an IDENTITY TRANSFORM on POSIX, so gbrain's 100%-ubuntu CI can never
# surface it — which is why the same defect was independently reintroduced FOUR
# times (sync ×3, archive-crawler ×1) and why 15 call sites sat broken while CI
# stayed green. That history is the whole justification for a static guard.
#
# THE FIX: `isPathInside(child, parent)` / `isPathStrictlyInside` from
# `src/core/path-confine.ts`. They delegate to `path.relative()`, which handles
# separators, mixed separator styles, win32 NTFS case-folding, the `/foo` vs
# `/foobar` boundary and cross-volume paths — with no `process.platform` branch,
# and byte-identical behavior on POSIX.
#
# WHAT IS FLAGGED — a `.startsWith(<expr> + '/')` (or the `+ "/"` / backtick
# spelling) where the expression looks like a filesystem path: it is derived from
# resolve/realpath/join/dirname/cwd/homedir/tmpdir/__dirname, or its name ends in
# a path-ish noun (Path, Dir, Root, Base, Home, File). Also flags the two-step
# form where the `+ '/'` is bound to a variable first:
#     const withSep = parent + '/';  …  child.startsWith(withSep)
#
# WHAT IS NOT FLAGGED:
#   - gbrain SLUGS and git-relative paths, which are forward-slash on every
#     platform by definition. Those are correct as written; a `sep` there would
#     be an actual bug. Mark them with a `path-sep-guard-ok` comment.
#   - comments (line + block are stripped, so this header does not trip it).
#   - any line carrying an explicit `path-sep-guard-ok` opt-out marker.
#
# Heuristic by design (line-oriented scan, not a parser) — the behavioral
# backstop is `test/path-boundary.test.ts`, whose win32 block fails against the
# old idiom. That block SKIPS on CI, which is exactly why this guard exists.
#
# Usage:
#   bash scripts/check-path-sep-boundary.sh            # scan the git-tracked tree
#   bash scripts/check-path-sep-boundary.sh DIR [DIR…] # scan explicit dirs (fixtures)
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

SRC_EXT_RE='\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$'
SKIP_RE='(^|/)(node_modules|dist|build|coverage|\.next|\.git)/|\.min\.js$'

# Every violation shape contains `startsWith`, so a file-level prefilter is sound
# and keeps the guard fast.
PROBE='startsWith'

list_files() {
  if [ "$IN_GIT" = 1 ]; then
    git grep -lI --untracked -e "$PROBE" -- \
      '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' 2>/dev/null |
      grep -vE "$SKIP_RE" || true
  else
    local cand
    cand="$(find "${@:-.}" -type f 2>/dev/null | grep -E "$SRC_EXT_RE" | grep -vE "$SKIP_RE")"
    [ -n "$cand" ] || return 0
    printf '%s\n' "$cand" | tr '\n' '\0' | xargs -0 grep -lE "$PROBE" 2>/dev/null || true
  fi
}

read -r -d '' AWK_PROG <<'AWK_EOF'
BEGIN {
  # Calls whose result is a filesystem path. Shared by learn() and learnsep().
  PATHCALL = "(resolve|resolvePath|realpathSync|realpathOrResolve|join|dirname|cwd\\(\\)|homedir\\(\\)|tmpdir\\(\\)|__dirname|import\\.meta\\.dir)"
  # Word components that mark an identifier as naming a filesystem path.
  # Deliberately EXCLUDES "prefix" and "scope" — too generic, and the two-step
  # detector already covers those via PATHCALL.
  split("path paths dir dirs directory root base home file filepath cwd tmp temp abs canonical real resolved full folder repo workspace target source", PW, / /)
  for (i in PW) PATHWORD[PW[i]] = 1
}
# Blank out comments. Scheme separators are neutralized first so `https://x` is
# not mistaken for the start of a line comment.
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

# Does this identifier look like a filesystem path rather than a slug?
#
# Matched on camelCase/snake_case WORD components, not as a bare substring: a
# prefix/suffix test missed `archiveDirAbs` (the real inbox-folder bug), while a
# naive substring test would flag `databaseName` for containing "base" and
# `prefixKind` for containing "prefix". Splitting into words gets both right.
function pathish(v,   w, i, n, parts) {
  if (v in pathvar) return 1
  w = v
  gsub(/\./, " ", w)                 # obj.field -> two words
  gsub(/_/, " ", w)                  # snake_case
  # camelCase boundary. `" &"` (whole-match reference), NOT a `\1 \2`
  # backreference — POSIX awk has no capture-group backreferences in a gsub
  # replacement, so `\1` would be inserted LITERALLY and silently corrupt every
  # word split (which is how `canonicalBase` stopped matching).
  gsub(/[A-Z]/, " &", w)
  n = split(tolower(w), parts, / +/)
  for (i = 1; i <= n; i++) if (parts[i] in PATHWORD) return 1
  return 0
}

# Remember variables bound to something obviously filesystem-derived.
function learn(t,   seg, v) {
  if (t !~ PATHCALL) return
  if (!match(t, /(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=/)) return
  seg = substr(t, RSTART, RLENGTH)
  sub(/^(const|let|var)[ \t]+/, "", seg)
  if (match(seg, /^[A-Za-z_$][A-Za-z0-9_$]*/)) pathvar[substr(seg, 1, RLENGTH)] = 1
}

# Remember `const x = <expr> + '/'` so the two-step form is caught.
function learnsep(t,   seg, v, src) {
  if (t !~ /\+[ \t]*['"`]\/['"`]/) return
  if (!match(t, /(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=/)) return
  seg = substr(t, RSTART, RLENGTH)
  sub(/^(const|let|var)[ \t]+/, "", seg)
  if (!match(seg, /^[A-Za-z_$][A-Za-z0-9_$]*/)) return
  v = substr(seg, 1, RLENGTH)
  src = t
  sub(/^[^=]*=[ \t]*/, "", src)
  # The right-hand side counts as a filesystem path either because it CALLS a
  # path-deriving function (`resolve(root, sub) + '/'` — the real sync.ts:3620
  # shape, whose leading identifier is the callee, not a path-ish name) or
  # because its first identifier is itself path-ish / already known.
  if (src ~ PATHCALL) { sepvar[v] = "a resolved path"; return }
  if (match(src, /[A-Za-z_$][A-Za-z0-9_$.]*/)) {
    if (pathish(substr(src, RSTART, RLENGTH))) sepvar[v] = substr(src, RSTART, RLENGTH)
  }
}

function report(f, l, t, why,   key, txt) {
  key = f ":" l
  if (key in seen) return
  seen[key] = 1
  txt = trim(unprot(t))
  if (length(txt) > 140) txt = substr(txt, 1, 137) "..."
  printf "  %s:%d\n      %s\n      %s\n", f, l, txt, why
}

function check(t, lno,   v, esc) {
  learn(t)
  learnsep(t)
  if (t !~ /\.startsWith[ \t]*\(/) return

  # Direct form: .startsWith(<ident> + '/')
  if (match(t, /\.startsWith[ \t]*\([ \t]*[A-Za-z_$][A-Za-z0-9_$.]*[ \t]*\+[ \t]*['"`]\/['"`][ \t]*\)/)) {
    esc = substr(t, RSTART, RLENGTH)
    if (match(esc, /\([ \t]*[A-Za-z_$][A-Za-z0-9_$.]*/)) {
      v = substr(esc, RSTART + 1, RLENGTH - 1)
      gsub(/^[ \t]+/, "", v)
      if (pathish(v)) {
        report(FILENAME, lno, t,
          "filesystem directory boundary built with a hardcoded '/' — never matches on Windows, where resolve()/realpathSync() emit '\\'. Use isPathInside() from src/core/path-confine.ts")
        return
      }
    }
  }

  # Two-step form: .startsWith(<var bound earlier to path + '/'>)
  for (v in sepvar) {
    esc = v; gsub(/\$/, "\\$", esc)
    if (t ~ ("\\.startsWith[ \t]*\\([ \t]*" esc "[ \t]*\\)")) {
      report(FILENAME, lno, t,
        "`" v "` was built as `" sepvar[v] " + \"/\"` — a hardcoded separator that never matches on Windows. Use isPathInside() from src/core/path-confine.ts")
      return
    }
  }
}

FNR == 1 { inblock = 0; delete pathvar; delete sepvar; armed = 0 }

{
  code = strip($0)
  # The opt-out marker suppresses the line it sits on AND the next few code
  # lines, so it can be written in the explanatory comment block above the
  # expression (the natural style here) rather than crammed onto the end of it.
  # A multi-line arrow function is why the window is 4 and not 1.
  if ($0 ~ /path-sep-guard-ok/) { armed = 4; next }
  if (armed > 0) { armed--; learn(code); learnsep(code); next }
  check(code, FNR)
}
AWK_EOF

LIST="$(list_files "$@")"

if [ -z "$LIST" ]; then
  echo "check-path-sep-boundary: ok (no candidate files)"
  exit 0
fi

OUT="$(printf '%s\n' "$LIST" | tr '\n' '\0' | xargs -0 awk "$AWK_PROG" || true)"

if [ -n "$OUT" ]; then
  {
    echo "ERROR: filesystem directory boundary compared with a hardcoded '/':"
    echo
    echo "$OUT"
    echo "Use the shared boundary primitive instead:"
    echo
    echo "    import { isPathInside } from 'src/core/path-confine.ts';"
    echo "    if (!isPathInside(child, parent)) throw new Error('outside root');"
    echo
    echo "It delegates to path.relative(), which handles separators, mixed"
    echo "separator styles, win32 NTFS case-folding and the /foo-vs-/foobar"
    echo "boundary — and is byte-identical on POSIX. A hardcoded '/' is an"
    echo "IDENTITY TRANSFORM on POSIX, so a green Linux CI run does NOT mean"
    echo "this works on Windows; this exact defect has been reintroduced four"
    echo "times."
    echo
    echo "If the flagged line compares gbrain SLUGS or git-relative paths (both"
    echo "forward-slash on every platform, where 'sep' would be WRONG), append a"
    echo "'path-sep-guard-ok' comment to it with the reason."
  } >&2
  exit 1
fi

echo "check-path-sep-boundary: ok (no hardcoded path separators; $(printf '%s\n' "$LIST" | wc -l | tr -d ' ') candidate file(s) scanned)"
