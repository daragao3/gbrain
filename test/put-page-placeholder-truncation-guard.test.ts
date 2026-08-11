/**
 * Placeholder-truncation guard (2026-08-10 KB incident).
 *
 * Bug: a single agent session rewrote three pages inside 53 seconds, each time
 * replacing most of the compiled truth with a self-refuting bracketed line that
 * ASSERTS the content is unchanged while being the very edit that removed it:
 *
 *   "[Previous sections 1-3 and Open Items omitted for brevity - unchanged from prior revision]"
 *   "[Same as prior revision - unchanged]"
 *   "[Remaining sections - degraded signals, durable operating rules - unchanged]"
 *
 * ~12KB of verified fact vanished. Every write reported success. A reader got
 * no signal at all — the page just looked short.
 *
 * The detector is STRUCTURAL, not lexical. A wording-based grep for
 * "omitted for brevity" / "unchanged from prior revision" provably MISSES real
 * cases (it misses the third line above). The validated shape is:
 *
 *     trimmed line matches /^\[.{10,}\]$/   AND   does not start with "[["
 *
 * Run against the live 487-page corpus that shape returns genuine placeholders
 * plus three benign false positives (an inline PowerShell subscript expression
 * and two bracketed protocol-notation lines). Those false positives are why the
 * refusal is gated on placeholder AND a material shrink: ordinary bracketed
 * prose in a page that is holding steady or growing is never blocked.
 *
 * Contract: importFromContent REFUSES the write (status 'error', message
 * prefixed PLACEHOLDER_TRUNCATION) so the existing compiled truth survives
 * untouched, and put_page returns a loud `truncation` envelope naming the
 * offending line. Escape hatches: `allow_truncation: true` per call, or
 * GBRAIN_NO_TRUNCATION_GUARD=1 for the file-sync path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  assessPlaceholderTruncation,
  findPlaceholderLines,
  PLACEHOLDER_MIN_REMOVED_CHARS,
} from '../src/core/placeholder-truncation.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

const F = '---';

// The three verbatim placeholder lines recovered from the damaged pages.
const INCIDENT_LINES = [
  '[Previous sections 1-3 and Open Items omitted for brevity - unchanged from prior revision]',
  '[Same as prior revision - unchanged]',
  '[Remaining sections - degraded signals, durable operating rules - unchanged]',
];

describe('findPlaceholderLines: structural detection', () => {
  for (const line of INCIDENT_LINES) {
    test(`detects the incident line: ${line.slice(0, 40)}…`, () => {
      expect(findPlaceholderLines(`Real prose.\n\n${line}\n\nMore prose.`)).toEqual([line]);
    });
  }

  test('a lexical wording grep would miss the third line — structure catches all three', () => {
    const body = INCIDENT_LINES.join('\n\n');
    expect(findPlaceholderLines(body)).toEqual(INCIDENT_LINES);
  });

  test('leading indentation does not hide a placeholder', () => {
    expect(findPlaceholderLines('    [Remaining sections - unchanged]')).toEqual([
      '[Remaining sections - unchanged]',
    ]);
  });

  test('CRLF line endings do not hide a placeholder', () => {
    expect(findPlaceholderLines(`prose\r\n[Sections 2-4 omitted here]\r\nprose`)).toEqual([
      '[Sections 2-4 omitted here]',
    ]);
  });

  test('wikilinks are excluded', () => {
    expect(findPlaceholderLines('[[Some Long Page Name Here]]')).toEqual([]);
  });

  test('a short bracketed token is below the 10-char floor', () => {
    expect(findPlaceholderLines('[unchanged]')).toEqual([]);
  });

  test('a markdown link line is not a placeholder', () => {
    expect(findPlaceholderLines('[a fairly long link label](https://example.com/x)')).toEqual([]);
  });

  test('a task-list checkbox is not a placeholder', () => {
    expect(findPlaceholderLines('- [ ] finish the migration writeup')).toEqual([]);
  });

  test('a link reference definition is not a placeholder', () => {
    expect(findPlaceholderLines('[some long reference]: https://example.com')).toEqual([]);
  });

  test('bracketed text inline within a sentence is not a placeholder', () => {
    expect(findPlaceholderLines('The value [as noted in the prior revision] is stable.')).toEqual([]);
  });

  // These two DO match the structural detector. They are real lines from the
  // live corpus and they are benign. Pinning them here documents exactly why
  // the refusal must additionally require a material shrink — the detector
  // alone is not a safe blocking signal.
  test('known benign corpus lines match the detector (hence the shrink pairing)', () => {
    expect(findPlaceholderLines('[int]$tokens[$tokens.Count - 1]')).toHaveLength(1);
    expect(findPlaceholderLines('[LLM action="run" target="cycle"]')).toHaveLength(1);
  });
});

describe('assessPlaceholderTruncation: placeholder AND material shrink', () => {
  const existing = 'x'.repeat(6000);

  test('placeholder plus a large shrink refuses', () => {
    const incoming = `Intro.\n\n${INCIDENT_LINES[0]}\n`;
    const verdict = assessPlaceholderTruncation({ incoming, existing });
    expect(verdict.shouldRefuse).toBe(true);
    expect(verdict.placeholderLines).toEqual([INCIDENT_LINES[0]]);
    expect(verdict.removedChars).toBeGreaterThan(PLACEHOLDER_MIN_REMOVED_CHARS);
  });

  test('placeholder in a GROWING page is allowed', () => {
    const incoming = existing + `\n\n[LLM action="run" target="cycle"]\n` + 'y'.repeat(2000);
    expect(assessPlaceholderTruncation({ incoming, existing }).shouldRefuse).toBe(false);
  });

  test('placeholder with only a trivial shrink is allowed', () => {
    const incoming = 'x'.repeat(5950) + `\n[int]$tokens[$tokens.Count - 1]`;
    expect(assessPlaceholderTruncation({ incoming, existing }).shouldRefuse).toBe(false);
  });

  test('a large shrink WITHOUT a placeholder is allowed (deliberate rewrites are legal)', () => {
    expect(assessPlaceholderTruncation({ incoming: 'x'.repeat(500), existing }).shouldRefuse).toBe(false);
  });

  test('a new page (no existing content) is never refused', () => {
    const incoming = `Intro.\n\n${INCIDENT_LINES[1]}\n`;
    expect(assessPlaceholderTruncation({ incoming, existing: null }).shouldRefuse).toBe(false);
    expect(assessPlaceholderTruncation({ incoming, existing: '' }).shouldRefuse).toBe(false);
  });

  test('a small page cannot trip the guard (absolute floor on removed characters)', () => {
    const small = 'x'.repeat(300);
    const incoming = INCIDENT_LINES[2];
    expect(assessPlaceholderTruncation({ incoming, existing: small }).shouldRefuse).toBe(false);
  });
});

describe('importFromContent refuses a placeholder-shaped truncation', () => {
  let engine: PGLiteEngine;

  const slug = 'projects/acme-example';
  const SEEDED_BODY = [
    '## Section 1 — how it works',
    'z'.repeat(2000),
    '',
    '## Section 2 — verified facts',
    'z'.repeat(2000),
    '',
    '## Section 3 — open items',
    'z'.repeat(2000),
  ].join('\n');
  const SEEDED = `${F}\ntitle: Acme Example\ntype: project\n${F}\n\n${SEEDED_BODY}\n`;
  const TRUNCATED = `${F}\ntitle: Acme Example\ntype: project\n${F}\n\n## Section 4 — new note\n\nA fresh paragraph.\n\n${INCIDENT_LINES[0]}\n`;

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

  async function seed() {
    const seeded = await importFromContent(engine, slug, SEEDED, {
      noEmbed: true,
      sourceId: 'default',
    });
    expect(seeded.status).toBe('imported');
  }

  test('the existing compiled truth survives the truncating overwrite', async () => {
    await seed();

    const result = await importFromContent(engine, slug, TRUNCATED, {
      noEmbed: true,
      sourceId: 'default',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('PLACEHOLDER_TRUNCATION');
    // The message must name the offending line so the agent can fix its payload.
    expect(result.error).toContain(INCIDENT_LINES[0]);

    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('Section 1 — how it works');
    expect(page!.compiled_truth).toContain('Section 3 — open items');
    expect(page!.compiled_truth.length).toBeGreaterThan(6000);
  }, 60_000);

  test('allow_truncation lets a deliberate compaction through', async () => {
    await seed();

    const result = await importFromContent(engine, slug, TRUNCATED, {
      noEmbed: true,
      sourceId: 'default',
      allowTruncation: true,
    });

    expect(result.status).toBe('imported');
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('Section 4 — new note');
  }, 60_000);

  test('GBRAIN_NO_TRUNCATION_GUARD=1 disables the guard for the sync path', async () => {
    await seed();

    const result = await withEnv({ GBRAIN_NO_TRUNCATION_GUARD: '1' }, () =>
      importFromContent(engine, slug, TRUNCATED, { noEmbed: true, sourceId: 'default' }),
    );

    expect(result.status).toBe('imported');
  }, 60_000);

  test('a shrink WITHOUT a placeholder still writes normally', async () => {
    await seed();

    const shorter = `${F}\ntitle: Acme Example\ntype: project\n${F}\n\n## Section 4\n\nDeliberately much shorter now.\n`;
    const result = await importFromContent(engine, slug, shorter, {
      noEmbed: true,
      sourceId: 'default',
    });

    expect(result.status).toBe('imported');
  }, 60_000);

  test('a NEW page carrying a bracketed line is created normally', async () => {
    const result = await importFromContent(
      engine,
      'projects/widget-co',
      `${F}\ntitle: Widget Co\ntype: project\n${F}\n\n${INCIDENT_LINES[1]}\n`,
      { noEmbed: true, sourceId: 'default' },
    );
    expect(result.status).toBe('imported');
  }, 60_000);

  test('a growing page keeps its benign bracketed protocol lines', async () => {
    await seed();

    const grown = `${F}\ntitle: Acme Example\ntype: project\n${F}\n\n${SEEDED_BODY}\n\n[LLM action="run" target="cycle"]\n\n${'z'.repeat(500)}\n`;
    const result = await importFromContent(engine, slug, grown, {
      noEmbed: true,
      sourceId: 'default',
    });

    expect(result.status).toBe('imported');
  }, 60_000);
});

describe('put_page surfaces a loud truncation envelope', () => {
  let engine: PGLiteEngine;
  const putPageOp = operations.find((o) => o.name === 'put_page')!;

  const slug = 'projects/widget-series-a';
  const SEEDED = `${F}\ntitle: Widget Series A\ntype: project\n${F}\n\n## Facts\n\n${'z'.repeat(6000)}\n`;
  const TRUNCATED = `${F}\ntitle: Widget Series A\ntype: project\n${F}\n\n## Facts\n\n${INCIDENT_LINES[2]}\n`;

  function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
    return {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      ...opts,
    };
  }

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

  test('the refusal envelope names the line, says the page is unchanged, and gives the override', async () => {
    const ctx = makeCtx();
    const seeded = await putPageOp.handler(ctx, { slug, content: SEEDED });
    expect((seeded as { status?: string }).status).not.toBe('error');

    const refused = await putPageOp.handler(ctx, { slug, content: TRUNCATED }) as {
      status: string;
      error?: string;
      truncation?: {
        error: string;
        detail: string;
        page_unchanged: boolean;
        placeholder_lines: string[];
        removed_chars: number;
        hint: string;
      };
    };

    expect(refused.status).toBe('error');
    expect(refused.truncation).toBeDefined();
    expect(refused.truncation!.error).toBe('placeholder_truncation');
    expect(refused.truncation!.page_unchanged).toBe(true);
    expect(refused.truncation!.placeholder_lines).toEqual([INCIDENT_LINES[2]]);
    expect(refused.truncation!.removed_chars).toBeGreaterThan(PLACEHOLDER_MIN_REMOVED_CHARS);
    expect(refused.truncation!.hint).toContain('allow_truncation');

    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth.length).toBeGreaterThan(5000);
  }, 60_000);

  test('put_page allow_truncation param overrides the refusal', async () => {
    const ctx = makeCtx();
    await putPageOp.handler(ctx, { slug, content: SEEDED });

    const result = await putPageOp.handler(ctx, {
      slug,
      content: TRUNCATED,
      allow_truncation: true,
    }) as { status: string };

    expect(result.status).not.toBe('error');
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth.length).toBeLessThan(1000);
  }, 60_000);

  test('a remote (untrusted) caller is guarded the same way', async () => {
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, { slug, content: SEEDED });

    const refused = await putPageOp.handler(ctx, { slug, content: TRUNCATED }) as {
      status: string;
      truncation?: { error: string };
    };

    expect(refused.status).toBe('error');
    expect(refused.truncation!.error).toBe('placeholder_truncation');
  }, 60_000);
});
