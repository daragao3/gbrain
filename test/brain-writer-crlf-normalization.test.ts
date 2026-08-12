/**
 * BrainWriter line-ending normalization (defense-in-depth).
 *
 * `importFromContent` is the ingest chokepoint that makes stored content
 * LF-only. BrainWriter does NOT pass through it — every WriteTx method calls
 * `engine.putPage` / `engine.addTimelineEntry` directly — so the LF invariant
 * has to be enforced here separately or it simply does not hold on this path.
 *
 * These tests assert the invariant at the surface rather than at the caller.
 * Today's callers synthesize from an LLM and are LF by construction, so the
 * normalization is a no-op for them; that is exactly why a regression here
 * would be invisible until a future caller feeds it a file, a webhook body, or
 * a CRLF Windows checkout. Stored CRLF makes a page invisible to `\n`-based
 * search — it reads as "already gone" while sitting right there (2026-08-10).
 *
 * Runs against PGLite in-memory. No network.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ResolverContext } from '../src/core/resolvers/index.ts';
import { BrainWriter } from '../src/core/output/writer.ts';

let engine: BrainEngine;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'writer-crlf-test-'));
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbDir });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

async function reset(): Promise<void> {
  await engine.executeRaw('TRUNCATE pages, links, content_chunks, timeline_entries, tags, raw_data, page_versions RESTART IDENTITY CASCADE');
}

function makeCtx(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    requestId: 'test',
    remote: false,
    ...overrides,
  };
}

/** Count raw CR bytes — the thing that must never reach storage. */
function crCount(s: string): number {
  return (s.match(/\r/g) ?? []).length;
}

// The incident's exact shape: a target string that spans a line break. Stored
// as CRLF, an `\n`-based search for it returns zero matches.
const CRLF_BODY = 'Alice runs untracked infra\r\nscript audits.\r\nSecond line.\r\n';
const LF_BODY = 'Alice runs untracked infra\nscript audits.\nSecond line.\n';

describe('BrainWriter CRLF normalization', () => {
  beforeEach(async () => { await reset(); });

  test('the fixture really carries CR (control for every assertion below)', () => {
    // Without this, a green suite could mean "normalization works" OR
    // "the fixture never had CR" — the false negative this whole change is about.
    expect(crCount(CRLF_BODY)).toBe(3);
    expect(crCount(LF_BODY)).toBe(0);
  });

  test('createEntity stores compiled truth LF-only', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/alice',
      displayName: 'Alice',
      type: 'person',
      compiledTruth: CRLF_BODY,
    }), makeCtx());

    const page = await engine.getPage('people/alice');
    expect(page).not.toBeNull();
    expect(crCount(page!.compiled_truth)).toBe(0);
    expect(page!.compiled_truth).toBe(LF_BODY);
  });

  test('createEntity stores the timeline LF-only', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/bob',
      displayName: 'Bob',
      type: 'person',
      compiledTruth: 'Bob.',
      timeline: '- 2026-08-11: line one\r\n- 2026-08-12: line two\r\n',
    }), makeCtx());

    const page = await engine.getPage('people/bob');
    expect(crCount(page!.timeline)).toBe(0);
    expect(page!.timeline).toContain('line one\n');
  });

  test('a page written through BrainWriter is findable by an \\n-based search', async () => {
    // The regression this guards is not "CR is ugly" — it is that the stored
    // page stops matching the pattern a reader would write.
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/carol',
      displayName: 'Carol',
      type: 'person',
      compiledTruth: CRLF_BODY,
    }), makeCtx());

    const page = await engine.getPage('people/carol');
    expect(page!.compiled_truth.includes('untracked infra\nscript')).toBe(true);
    // And the CRLF form is genuinely absent, not merely also present.
    expect(page!.compiled_truth.includes('untracked infra\r\nscript')).toBe(false);
  });

  test('setCompiledTruth stores LF-only', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/dave',
      displayName: 'Dave',
      type: 'person',
      compiledTruth: 'seed',
    }), makeCtx());

    await writer.transaction(async (tx) => {
      await tx.setCompiledTruth('people/dave', CRLF_BODY);
    }, makeCtx());

    const page = await engine.getPage('people/dave');
    expect(crCount(page!.compiled_truth)).toBe(0);
    expect(page!.compiled_truth).toBe(LF_BODY);
  });

  test('setFrontmatterField heals a legacy CR page instead of copying CR forward', async () => {
    // Write CR directly past the writer to simulate a page stored before the
    // fix, then touch only a frontmatter key. The rewrite must not preserve CR.
    await engine.putPage('people/erin', {
      type: 'person',
      title: 'Erin',
      compiled_truth: CRLF_BODY,
      timeline: '- 2026-08-11: legacy\r\n',
      frontmatter: {},
    });
    const before = await engine.getPage('people/erin');
    expect(crCount(before!.compiled_truth)).toBe(3); // control: CR really landed

    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => {
      await tx.setFrontmatterField('people/erin', 'status', 'active');
    }, makeCtx());

    const after = await engine.getPage('people/erin');
    expect(after!.frontmatter.status).toBe('active');
    expect(crCount(after!.compiled_truth)).toBe(0);
    expect(crCount(after!.timeline)).toBe(0);
  });

  test('appendTimeline stores summary and detail LF-only', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/frank',
      displayName: 'Frank',
      type: 'person',
      compiledTruth: 'Frank.',
    }), makeCtx());

    await writer.transaction(async (tx) => {
      await tx.appendTimeline('people/frank', {
        date: '2026-08-11',
        summary: 'summary line one\r\nsummary line two',
        detail: 'detail line one\r\ndetail line two',
      });
    }, makeCtx());

    const rows = await engine.executeRaw(
      `SELECT summary, detail FROM timeline_entries WHERE summary LIKE 'summary line%'`,
      [],
    );
    expect(rows.length).toBe(1);
    expect(crCount(rows[0].summary as string)).toBe(0);
    expect(crCount((rows[0].detail as string) ?? '')).toBe(0);
    expect(rows[0].summary).toBe('summary line one\nsummary line two');
  });

  test('appendTimeline leaves an absent detail absent (no undefined-to-empty coercion)', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/grace',
      displayName: 'Grace',
      type: 'person',
      compiledTruth: 'Grace.',
    }), makeCtx());

    await writer.transaction(async (tx) => {
      await tx.appendTimeline('people/grace', {
        date: '2026-08-11',
        summary: 'no detail here',
      });
    }, makeCtx());

    const rows = await engine.executeRaw(
      `SELECT detail FROM timeline_entries WHERE summary = 'no detail here'`,
      [],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].detail == null || rows[0].detail === '').toBe(true);
  });

  test('LF content is passed through untouched', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/heidi',
      displayName: 'Heidi',
      type: 'person',
      compiledTruth: LF_BODY,
    }), makeCtx());

    const page = await engine.getPage('people/heidi');
    expect(page!.compiled_truth).toBe(LF_BODY);
  });

  test('a lone CR collapses to LF too', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/ivan',
      displayName: 'Ivan',
      type: 'person',
      compiledTruth: 'old-mac line one\rline two',
    }), makeCtx());

    const page = await engine.getPage('people/ivan');
    expect(crCount(page!.compiled_truth)).toBe(0);
    expect(page!.compiled_truth).toBe('old-mac line one\nline two');
  });
});
