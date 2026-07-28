/**
 * `gbrain skillpack list --json` frontmatter description parsing.
 *
 * Regression cover for the CRLF class: an LF-only frontmatter fence
 * (`/^---\n/`) cannot match a file that starts `---\r\n`, so a CRLF SKILL.md
 * parsed as having NO frontmatter — silently, with no error — and every
 * bundled skill reported `"description": null`. On Windows
 * `core.autocrlf=true` (the Git-for-Windows installer default) makes every
 * checked-out SKILL.md CRLF, so this fired for the whole bundle.
 */

import { describe, expect, it } from 'bun:test';

import { parseSkillDescription } from '../src/commands/skillpack.ts';

const LF_SKILL = [
  '---',
  'name: example-skill',
  'description: Does the example thing.',
  'triggers:',
  '  - "do the example"',
  '---',
  '',
  '# Example Skill',
  '',
].join('\n');

const CRLF_SKILL = LF_SKILL.replace(/\n/g, '\r\n');

describe('parseSkillDescription', () => {
  it('reads description: from an LF SKILL.md', () => {
    expect(parseSkillDescription(LF_SKILL)).toBe('Does the example thing.');
  });

  it('reads description: from a CRLF SKILL.md', () => {
    // The bug: null, because the fence never matched.
    expect(parseSkillDescription(CRLF_SKILL)).toBe('Does the example thing.');
  });

  it('CRLF and LF yield an identical description', () => {
    const crlf = parseSkillDescription(CRLF_SKILL);
    expect(crlf).toBe(parseSkillDescription(LF_SKILL));
    // No trailing \r smuggled into the JSON payload.
    expect(crlf).not.toContain('\r');
  });

  it('handles a quoted description on a CRLF file', () => {
    const src = '---\r\nname: q\r\ndescription: "Quoted value."\r\n---\r\n\r\n# Body\r\n';
    expect(parseSkillDescription(src)).toBe('Quoted value.');
  });

  it('returns null when a CRLF file genuinely has no frontmatter', () => {
    // No fence at all — the parser MUST report absence, not invent a value.
    const src = '# Example Skill\r\n\r\ndescription: not in frontmatter\r\n';
    expect(parseSkillDescription(src)).toBeNull();
  });

  it('returns null when CRLF frontmatter exists but declares no description', () => {
    const src = '---\r\nname: example-skill\r\n---\r\n\r\n# Example Skill\r\n';
    expect(parseSkillDescription(src)).toBeNull();
  });
});
