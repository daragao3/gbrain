/**
 * pages.timeline COLUMN preservation on marker-less writes.
 *
 * The `pages.timeline` TEXT column is populated by `splitBody` from whatever
 * follows a timeline sentinel (`<!-- timeline -->`) in the written body. Every
 * page-write primitive assigned it unconditionally — `putPage`'s upsert
 * (`timeline = EXCLUDED.timeline`) and `compareAndSwapPage`'s UPDATE — while
 * the sibling provenance columns right beneath them (source_kind, ingested_at,
 * …) all COALESCE against `pages.*`. Because a body with no sentinel parses to
 * `timeline: ''`, ANY rewrite that didn't happen to carry a sentinel silently
 * erased the column, with nothing in the response mentioning it
 * (`auto_timeline.created` reports on the timeline_entries TABLE, which is a
 * different thing and was never affected).
 *
 * This is not the same hazard as clobbering the timeline_entries table, and it
 * is easy to miss because nearly every page stores '' here — only pages that
 * carry import provenance or a split-out history section hold anything.
 *
 * Contract pinned here: an EMPTY incoming timeline never clears a non-empty
 * stored one. Of the ~46 sites that construct a page, several hard-code
 * `timeline: ''` purely as filler (enrichment-service, extract-atoms,
 * import-file) meaning "not applicable" rather than "clear it", so
 * preserve-on-empty is what callers actually mean. A non-empty incoming
 * timeline still replaces, so genuine timeline edits land.
 *
 * All cases run against in-memory PGLite (hermetic, no DATABASE_URL). The
 * identical fix is applied to postgres-engine.ts, which these hermetic tests
 * do not exercise.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;
const conditionalOp = operations.find((o) => o.name === 'put_page_conditional')!;
if (!conditionalOp) throw new Error('put_page_conditional missing');

const PROVENANCE = '*Source: Hindsight shared bank (world)*\n*Imported: 2026-04-18T07:43:06.320Z*';

let engine: PGLiteEngine;

beforeAll(async () => {
  // Same hermeticity guard as put-page-provenance.test.ts: pin the gateway and
  // stub the embed transport so put_page's embed never touches the network.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 0 },
  }) as any);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  __resetFactsQueueForTests();
  resetGateway();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts', []);
  await engine.executeRaw('DELETE FROM pages', []);
  __setChatTransportForTests(null);
  __resetFactsQueueForTests();
});

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

/** Read the timeline COLUMN straight from the DB, bypassing get_page. */
async function readTimelineColumn(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw(
    'SELECT timeline FROM pages WHERE slug = $1',
    [slug],
  ) as Array<{ timeline: unknown }>;
  return (rows[0]?.timeline as string | null) ?? null;
}

async function readRevision(slug: string): Promise<number> {
  const rows = await engine.executeRaw(
    'SELECT revision FROM pages WHERE slug = $1',
    [slug],
  ) as Array<{ revision: unknown }>;
  return Number(rows[0]?.revision);
}

const withTimeline = (title: string, timeline = PROVENANCE) =>
  `---\ntype: note\ntitle: ${title}\n---\n\nbody\n\n<!-- timeline -->\n\n${timeline}`;

const withoutTimeline = (title: string) =>
  `---\ntype: note\ntitle: ${title}\n---\n\nbody, and no timeline sentinel anywhere`;

describe('put_page — timeline column baseline', () => {
  test('a body WITH a sentinel populates the timeline column', async () => {
    await putPageOp.handler(makeCtx(), {
      slug: 'wiki/tl-populate',
      content: withTimeline('Populate'),
    });
    expect(await readTimelineColumn('wiki/tl-populate')).toBe(PROVENANCE);
  });

  test('a FIRST write with no sentinel leaves the column empty (nothing fabricated)', async () => {
    await putPageOp.handler(makeCtx(), {
      slug: 'wiki/tl-fresh-empty',
      content: withoutTimeline('Fresh'),
    });
    expect(await readTimelineColumn('wiki/tl-fresh-empty')).toBe('');
  });
});

describe('put_page — marker-less rewrite must not erase the timeline column', () => {
  test('second write WITHOUT a sentinel preserves the stored timeline', async () => {
    const ctx = makeCtx();
    await putPageOp.handler(ctx, {
      slug: 'wiki/tl-preserve',
      content: withTimeline('V1'),
    });
    expect(await readTimelineColumn('wiki/tl-preserve')).toBe(PROVENANCE);

    // A routine edit that simply doesn't restate the timeline section.
    await putPageOp.handler(ctx, {
      slug: 'wiki/tl-preserve',
      content: withoutTimeline('V2'),
    });

    expect(await readTimelineColumn('wiki/tl-preserve')).toBe(PROVENANCE);
  });

  test('second write WITH a new sentinel still replaces the timeline', async () => {
    const ctx = makeCtx();
    await putPageOp.handler(ctx, {
      slug: 'wiki/tl-replace',
      content: withTimeline('V1'),
    });

    await putPageOp.handler(ctx, {
      slug: 'wiki/tl-replace',
      content: withTimeline('V2', '*Re-imported: 2026-08-11*'),
    });

    expect(await readTimelineColumn('wiki/tl-replace')).toBe('*Re-imported: 2026-08-11*');
  });
});

describe('put_page_conditional (compare_and_swap) — same preservation contract', () => {
  test('a marker-less CAS write preserves the stored timeline', async () => {
    const ctx = makeCtx();
    await putPageOp.handler(ctx, {
      slug: 'wiki/tl-cas-preserve',
      content: withTimeline('V1'),
    });
    expect(await readTimelineColumn('wiki/tl-cas-preserve')).toBe(PROVENANCE);

    const rev = await readRevision('wiki/tl-cas-preserve');
    const result = await conditionalOp.handler(ctx, {
      slug: 'wiki/tl-cas-preserve',
      content: withoutTimeline('V2'),
      mode: 'compare_and_swap',
      expected_revision: rev,
    });
    expect(result).toMatchObject({ status: 'updated' });

    expect(await readTimelineColumn('wiki/tl-cas-preserve')).toBe(PROVENANCE);
  });
});
