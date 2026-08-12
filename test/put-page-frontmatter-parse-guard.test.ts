/**
 * Frontmatter parse-failure guard (2026-07-23 KB audit).
 *
 * Bug: when a put_page payload opens with `---` and has a closing `---`, but
 * the enclosed YAML fails to parse, gray-matter's forgiving fallback swallowed
 * the whole block into the body and the page was written with DEFAULTS:
 * title <- slug-derived, type <- 'concept', tags <- []. The write reported
 * success. A KB-wide audit found 34 pages silently stripped this way.
 *
 * Two real-world triggers recovered from damaged pages:
 *   1. leading space before a mapping key (` type: theme`)
 *   2. unquoted colon inside a scalar (`title: Fed regime: no guidance`)
 *
 * Contract now: parseMarkdown surfaces `frontmatterError`, and
 * importFromContent REFUSES the write (status 'error') so existing
 * title/type/tags survive untouched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

const conditionalOp = operations.find(o => o.name === 'put_page_conditional');
if (!conditionalOp) throw new Error('put_page_conditional missing');

const F = '---';

// Trigger 1 — leading space makes ` type: theme` an invalid mapping entry.
const LEADING_SPACE = `${F}\ntitle: Higher for longer\n type: theme\ntags: [macro, rates]\n${F}\n\nBody prose.\n`;

// Trigger 2 — unquoted colon inside a scalar.
const UNQUOTED_COLON = `${F}\ntitle: Fed communication regime: no-forward-guidance posture\ntype: theme\n${F}\n\nBody prose.\n`;

describe('parseMarkdown: unparseable frontmatter is reported, not swallowed', () => {
  test('trigger 1 (leading-space key) sets frontmatterError', () => {
    const parsed = parseMarkdown(LEADING_SPACE, 'markets/themes/hfl.md');
    expect(parsed.frontmatterError).toBeDefined();
    expect(parsed.frontmatterError!.length).toBeGreaterThan(0);
  });

  test('trigger 2 (unquoted colon) sets frontmatterError', () => {
    const parsed = parseMarkdown(UNQUOTED_COLON, 'markets/themes/fed.md');
    expect(parsed.frontmatterError).toBeDefined();
  });

  // gray-matter stores `matter.cache[content] = file` BEFORE parsing, so a
  // payload that throws leaves an UNPARSED entry in the cache. Every later
  // call on identical content then returns data:{} + the raw body and never
  // throws — the detection must not depend on the throw.
  test('detection survives gray-matter cache poisoning (repeat calls)', () => {
    const first = parseMarkdown(LEADING_SPACE, 'a.md');
    const second = parseMarkdown(LEADING_SPACE, 'a.md');
    const third = parseMarkdown(LEADING_SPACE, 'a.md');
    expect(first.frontmatterError).toBeDefined();
    expect(second.frontmatterError).toBeDefined();
    expect(third.frontmatterError).toBeDefined();
  });

  test('well-formed frontmatter leaves frontmatterError undefined', () => {
    const md = `${F}\ntype: theme\ntitle: Fine\ntags: [a]\n${F}\n\nbody`;
    const parsed = parseMarkdown(md, 'x.md');
    expect(parsed.frontmatterError).toBeUndefined();
    expect(parsed.type).toBe('theme');
  });

  test('no frontmatter at all is NOT a parse error (inference still applies)', () => {
    const parsed = parseMarkdown('# Just a body\n\ntext', 'notes/x.md');
    expect(parsed.frontmatterError).toBeUndefined();
  });

  test('open fence with no close is NOT reported as a parse error', () => {
    const parsed = parseMarkdown(`${F}\ntype: note\n\n# heading\n`, 'x.md');
    expect(parsed.frontmatterError).toBeUndefined();
  });
});

describe('importFromContent refuses writes with unparseable frontmatter', () => {
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

  test('existing title/type/tags survive a broken-frontmatter overwrite', async () => {
    const slug = 'markets/themes/hfl';
    const seeded = await importFromContent(
      engine,
      slug,
      `${F}\ntitle: Higher for longer\ntype: theme\ntags: [macro, rates]\n${F}\n\nOriginal body.\n`,
      { noEmbed: true, sourceId: 'default' },
    );
    expect(seeded.status).toBe('imported');

    const result = await importFromContent(engine, slug, LEADING_SPACE, {
      noEmbed: true,
      sourceId: 'default',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('FRONTMATTER_PARSE');

    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.title).toBe('Higher for longer');
    expect(page!.type).toBe('theme');
    expect(page!.compiled_truth).toContain('Original body.');
    const tags = await engine.getTags(slug, { sourceId: 'default' });
    expect(tags.sort()).toEqual(['macro', 'rates']);
  });

  test('a NEW page with broken frontmatter is not created at all', async () => {
    const slug = 'markets/themes/fed-warsh';
    const result = await importFromContent(engine, slug, UNQUOTED_COLON, {
      noEmbed: true,
      sourceId: 'default',
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('FRONTMATTER_PARSE');
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
  });

  test('well-formed frontmatter still writes normally', async () => {
    const slug = 'markets/themes/ok';
    const result = await importFromContent(
      engine,
      slug,
      `${F}\ntitle: Fine Page\ntype: theme\n${F}\n\nBody.\n`,
      { noEmbed: true, sourceId: 'default' },
    );
    expect(result.status).toBe('imported');
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.title).toBe('Fine Page');
  });

  test('conditional operation preserves the explicit non-mutating parse-error shape', async () => {
    const slug = 'markets/themes/conditional-broken';
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    };
    const result = await conditionalOp.handler(ctx, {
      slug,
      content: LEADING_SPACE,
      mode: 'create_only',
    });
    expect(result).toMatchObject({
      slug,
      status: 'error',
      chunks: 0,
      frontmatter: { error: 'unparseable', page_unchanged: true },
    });
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
  });
});
