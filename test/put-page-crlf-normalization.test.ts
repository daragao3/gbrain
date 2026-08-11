/**
 * CRLF-on-ingest normalization (2026-08-10 KB incident).
 *
 * Bug: `gbrain capture --file <path>` on Windows read a PowerShell-written
 * file (PowerShell's Out-File / Set-Content emit CRLF) and stored the body
 * byte-for-byte. A single session's put_page of `projects/agent-fork` landed a
 * compiled truth carrying 549 CRLF pairs where every prior revision of that
 * page had been pure LF. `projects/jobflow` took 154 the same night. Both
 * are preserved in page_versions (ids 592 and 565).
 *
 * Why it matters beyond tidiness: it silently breaks searching over compiled
 * truth. A grep for a target string that happens to span a line break —
 * stored as `untracked infra\r\nscript` — returns ZERO matches for an
 * `\n`-based pattern. That reads as "the stale text is already gone" when it
 * is present, and it is only caught by a positive control. Exactly that false
 * negative occurred during the 2026-08-10 investigation.
 *
 * The old behavior was deliberate: capture.ts normalized line endings for the
 * content_hash only, and a comment claimed "CQ2's CRLF/BOM preservation tests
 * rely on this split". No test ever asserted CR bytes survive to storage —
 * the only CRLF assertions were that normalizeForHash collapses CRLF and that
 * CRLF frontmatter still parses. Both still hold below.
 *
 * Contract: importFromContent — the single chokepoint every compiled_truth
 * write passes through (put_page local + remote MCP, capture, sync/import) —
 * normalizes CRLF and lone CR to LF before parsing, hashing, chunking, and
 * the DB write. Storage is line-ending-canonical; readers stop needing to be
 * CRLF-tolerant to find their own content.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { normalizeLineEndings } from '../src/core/line-endings.ts';

const F = '---';

describe('normalizeLineEndings', () => {
  test('collapses CRLF to LF', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  test('collapses a lone CR to LF', () => {
    expect(normalizeLineEndings('a\rb\rc')).toBe('a\nb\nc');
  });

  test('handles mixed CRLF and lone CR in one pass', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  test('does not collapse an LF-only string, and returns it unchanged', () => {
    const s = 'a\nb\nc';
    expect(normalizeLineEndings(s)).toBe(s);
  });

  test('leaves blank lines intact rather than swallowing them', () => {
    expect(normalizeLineEndings('a\r\n\r\nb')).toBe('a\n\nb');
  });

  test('empty string is a no-op', () => {
    expect(normalizeLineEndings('')).toBe('');
  });

  test('preserves non-CR content byte-for-byte (CJK, emoji, BOM)', () => {
    const s = '﻿# 測試 🧠\n\nbody';
    expect(normalizeLineEndings(s)).toBe(s);
  });
});

describe('importFromContent normalizes line endings into compiled_truth', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    resetGateway();
  }, 120_000);

  async function put(slug: string, content: string) {
    const r = await importFromContent(engine, slug, content, {
      noEmbed: true,
      sourceId: 'default',
    });
    expect(r.status).toBe('imported');
    const page = await engine.getPage(slug, { sourceId: 'default' });
    return page!;
  }

  test('a CRLF body stores zero CR bytes', async () => {
    const body = ['## How it works', '', 'first line', 'second line', ''].join('\r\n');
    const content = `${F}\r\ntitle: CRLF Page\r\ntype: project\r\n${F}\r\n\r\n${body}`;

    const page = await put('projects/crlf-example', content);

    expect(page.compiled_truth).not.toContain('\r');
    expect(page.compiled_truth).toContain('## How it works');
    expect(page.compiled_truth).toContain('first line\nsecond line');
  }, 60_000);

  test('the incident false negative: an LF pattern finds text that spanned a CRLF break', async () => {
    // The literal shape that returned zero matches on 2026-08-10.
    const content =
      `${F}\r\ntitle: Agent Fork\r\ntype: project\r\n${F}\r\n\r\n` +
      `The remaining untracked infra\r\nscript is still pending.\r\n`;

    const page = await put('projects/crlf-false-negative', content);

    // Positive control: this is the assertion that fails on stored CRLF.
    expect(page.compiled_truth).toContain('untracked infra\nscript');
    expect(/untracked infra\nscript/.test(page.compiled_truth)).toBe(true);
  }, 60_000);

  test('a lone CR (no LF) is normalized too', async () => {
    const content = `${F}\ntitle: Lone CR\ntype: project\n${F}\n\nalpha\rbeta\n`;

    const page = await put('projects/crlf-lone', content);

    expect(page.compiled_truth).not.toContain('\r');
    expect(page.compiled_truth).toContain('alpha\nbeta');
  }, 60_000);

  test('the timeline section below the sentinel is normalized as well', async () => {
    const content =
      `${F}\r\ntitle: Timeline Page\r\ntype: project\r\n${F}\r\n\r\n` +
      `Compiled truth line.\r\n\r\n<!-- timeline -->\r\n- 2026-08-10: an entry\r\n`;

    const page = await put('projects/crlf-timeline', content);

    expect(page.compiled_truth).not.toContain('\r');
    expect(page.timeline ?? '').not.toContain('\r');
  }, 60_000);

  test('CRLF frontmatter still parses (the real CQ2 guarantee)', async () => {
    const content = `${F}\r\ntype: project\r\ntitle: CRLF Test\r\n${F}\r\n\r\nbody line\r\n`;

    const page = await put('projects/crlf-frontmatter', content);

    expect(page.title).toBe('CRLF Test');
    expect(page.type).toBe('project');
  }, 60_000);

  test('an already-LF body is stored byte-identically (no collateral rewrite)', async () => {
    const body = '## Section\n\nplain lf line\nanother\n';
    const content = `${F}\ntitle: LF Page\ntype: project\n${F}\n\n${body}`;

    const page = await put('projects/crlf-lf-control', content);

    expect(page.compiled_truth).toContain('plain lf line\nanother');
    expect(page.compiled_truth).not.toContain('\r');
  }, 60_000);

  test('CRLF and LF forms of the same page produce the same stored truth', async () => {
    const lf = `${F}\ntitle: Same\ntype: project\n${F}\n\nalpha\nbeta\ngamma\n`;
    const crlf = lf.replace(/\n/g, '\r\n');

    const a = await put('projects/crlf-equiv-a', lf);
    const b = await put('projects/crlf-equiv-b', crlf);

    expect(b.compiled_truth).toBe(a.compiled_truth);
  }, 60_000);
});
