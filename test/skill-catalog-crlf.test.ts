/**
 * CRLF regression for the `list_skills` / `get_skill` frontmatter projection.
 *
 * On Windows every `~/gbrain/skills/*​/SKILL.md` is CRLF (`---\r\n`, `\r\n`
 * line endings). Two LF-only assumptions in `skill-catalog.ts` collapsed every
 * published skill's catalog description to "" (verified 2026-07-13 once
 * `mcp.publish_skills` was enabled):
 *
 *   1. `parseDescriptionField` split `raw` on `\n`, leaving a trailing `\r` on
 *      each line. Its `/^description:[ \t]*(.*)$/` regex (no `m` flag) never
 *      matched, because `.` and `$` won't span/anchor across the `\r` — so the
 *      field was dropped for both inline and block-scalar (`|`/`>`) forms.
 *   2. `stripFrontmatterFence` used an LF-only fence, so on a CRLF file it
 *      matched nothing and returned the WHOLE file as the "body". The
 *      first-prose-line fallback then saw `---\r` and also collapsed to "",
 *      and `get_skill` returned the fence in its body.
 *
 * Sibling of the skill-frontmatter.ts CRLF fence fix (dabbf709 / c4c6a0dd).
 */
import { describe, test, expect } from 'bun:test';
import { oneLineDescription, stripFrontmatterFence } from '../src/core/skill-catalog.ts';

describe('oneLineDescription — CRLF frontmatter', () => {
  test('inline description on a CRLF line is extracted (not dropped by the $ anchor)', () => {
    const raw = [
      'name: academic-verify',
      'description: Verify academic claims against sources.',
      'triggers: [cite a paper]',
    ].join('\r\n');
    expect(oneLineDescription(raw, 'body fallback')).toBe(
      'Verify academic claims against sources.',
    );
  });

  test('block-scalar (|) description with CRLF folds its indented lines', () => {
    const raw = [
      'name: brain-ops',
      'description: |',
      '  Brain-first lookup protocol.',
      '  Second line continues it.',
      'triggers: [look it up]',
    ].join('\r\n');
    expect(oneLineDescription(raw, 'body fallback')).toBe(
      'Brain-first lookup protocol. Second line continues it.',
    );
  });

  test('quoted inline description with CRLF strips the surrounding quotes', () => {
    // A trailing field keeps the description line mid-frontmatter, so it
    // carries the `\r` that the `$`-anchor bug chokes on (not the last line).
    const raw = ['name: demo', 'description: "Quoted CRLF desc"', 'triggers: [x]'].join('\r\n');
    expect(oneLineDescription(raw, 'fallback')).toBe('Quoted CRLF desc');
  });
});

describe('stripFrontmatterFence — CRLF fence', () => {
  test('strips a CRLF (\\r\\n) fence and returns the prose body', () => {
    const content = [
      '---',
      'name: demo',
      'description: x',
      '---',
      'First body line.',
      'Second body line.',
    ].join('\r\n');
    const body = stripFrontmatterFence(content);
    expect(body.startsWith('First body line.')).toBe(true);
    expect(body).not.toContain('---');
    expect(body).not.toContain('name: demo');
  });

  test('still strips an LF (\\n) fence — no regression', () => {
    const content = ['---', 'name: demo', '---', 'Body prose.'].join('\n');
    expect(stripFrontmatterFence(content)).toBe('Body prose.');
  });

  test('content with no fence is returned unchanged', () => {
    const content = 'No frontmatter here.\r\nJust prose.';
    expect(stripFrontmatterFence(content)).toBe(content);
  });
});
