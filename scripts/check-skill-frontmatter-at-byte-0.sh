#!/usr/bin/env bash
# CI guard: every SKILL.md that HAS YAML frontmatter must OPEN with it.
#
# Nothing may precede the opening `---` fence — not a banner, not a comment,
# not a BOM. A single line above the fence is silently fatal:
# `parseSkillFrontmatter` anchors its fence regex at string start (no `m`
# flag), so any preamble makes the whole block unparseable. The skill then
# loses its `triggers:` and `brain_first:`, `gbrain doctor` reports it as
# `unreachable`, and `list_skills` / `get_skill` project an empty
# description for it.
#
# Why this guard exists (2026-07-28): `gbrain doctor --fix` did exactly this
# to two skills. `findInsertionLine` in src/core/dry-fix.ts compared
# `lines[0] === '---'` against `'---\r'` on a Windows checkout
# (`core.autocrlf=true` is the default), never matched, fell through to
# offset 0, and spliced the brain-first Convention callout ABOVE the fence.
# Both skills already declared `brain_first: exempt` — invisible for the
# same CRLF reason. The bug is fixed; this guard is what makes a
# reintroduction loud instead of silent.
#
# Deliberately narrow: it does NOT require frontmatter to exist. A file with
# no fence at all (e.g. the deprecated skills/install/SKILL.md tombstone) is
# fine. The failure mode being guarded is "frontmatter exists but something
# is in front of it", which is never intentional.
#
# Usage: scripts/check-skill-frontmatter-at-byte-0.sh
# Exit:  0 when every SKILL.md is clean; 1 on the first offender class.

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

violations=0
scanned=0

# Scan tracked SKILL.md files only — keeps the guard fast and stops it from
# walking node_modules or a nested worktree.
while IFS= read -r f; do
  [ -f "$f" ] || continue
  scanned=$((scanned + 1))

  # Does the file open with the fence? (`head -c 3` avoids reading it all.)
  first3="$(head -c 3 "$f")"
  [ "$first3" = "---" ] && continue

  # It does not open with `---`. Only a problem if a fence appears later,
  # i.e. there IS frontmatter and something got in front of it.
  if grep -qE '^---[[:space:]]*$' "$f"; then
    if [ "$violations" -eq 0 ]; then
      echo
      echo "ERROR: SKILL.md files with content ABOVE their YAML frontmatter."
      echo
      echo "The opening '---' must be at byte 0. Anything before it makes the"
      echo "frontmatter unparseable, which silently drops the skill's triggers"
      echo "and empties its description in list_skills/get_skill."
      echo
    fi
    violations=$((violations + 1))
    echo "  $f"
    echo "      first line: $(head -1 "$f" | cut -c1-100)"
  fi
done < <(git ls-files '*/SKILL.md' 'SKILL.md')

if [ "$violations" -gt 0 ]; then
  echo
  echo "Fix: move the offending line(s) BELOW the closing '---' of the"
  echo "frontmatter block. If a tool wrote it there, fix the writer — see"
  echo "findInsertionLine() in src/core/dry-fix.ts."
  echo
  exit 1
fi

echo "OK: all $scanned tracked SKILL.md files open with their frontmatter fence"
exit 0
