/**
 * Regression — a local `put_page` must not hard-delete managed link rows for
 * wikilinks that are STILL IN THE BODY but that the extractor cannot resolve.
 *
 * Observed as real data loss: a byte-identical re-put returned
 *   {"status":"skipped","chunks":0,"auto_links":{"created":0,"removed":4}}
 * and destroyed all four `link_source='markdown'` outbound edges of a page
 * whose body still carried the matching wikilinks. `links` has no tombstone
 * column, so the delete was unrecoverable.
 *
 * Root cause, and it is NOT the content-hash short-circuit: the desired set for
 * reconciliation comes from `extractPageLinks`, whose wikilink pass is gated on
 * the hardcoded `DIR_PATTERN` prefix whitelist. A wikilink under any other
 * prefix falls through to the generic pass, is tagged `needsResolution`, and is
 * DROPPED silently whenever `link_resolution.global_basename` is off (the
 * default). The desired set comes back empty, so every pre-existing managed
 * edge looks stale and is removed.
 *
 * That is also why a subsequent genuine (non-`skipped`) write did not re-derive
 * the edges — the gap is in extraction coverage, not in the skip path. Both are
 * pinned below.
 *
 * The fix must keep distinguishing:
 *   - "the body no longer references this"  → delete (stale-edge contract,
 *     pinned by test/e2e/global-basename-pglite.test.ts)
 *   - "the body still references this, we just couldn't resolve it" → keep.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  for (const t of [
    'content_chunks', 'links', 'tags', 'raw_data',
    'timeline_entries', 'page_versions', 'ingest_log', 'pages', 'config',
  ]) {
    try { await (engine as never as { db: { exec(q: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`); } catch { /* ok */ }
  }
}, 15_000);

async function putPageOp(params: Record<string, unknown>) {
  const { operations } = await import('../../src/core/operations.ts');
  const op = operations.find(o => o.name === 'put_page')!;
  return await op.handler({ engine, remote: false } as never, params) as {
    status: string;
    auto_links?: { created: number; removed: number; withheld?: number };
  };
}

// `notes/` and `archive/` are deliberately OUTSIDE DIR_PATTERN — that is the
// whole point. A `[[people/...]]` wikilink would extract normally and never
// reach the failure mode.
const SUBJECT = 'notes/write-semantics';
const TARGET_A = 'notes/prior-session';
const TARGET_B = 'archive/legacy-note';
const BOTH_TARGETS = [TARGET_B, TARGET_A].sort();

const BODY_WITH_UNRESOLVABLE_WIKILINKS = `---
title: Write Semantics
type: system
---

Compiled truth about put_page.

Related: [[${TARGET_A}]] and [[${TARGET_B}]].
`;

/** Seed the target pages plus the managed edges an earlier extraction left. */
async function seedPageAndManagedEdges() {
  for (const slug of [TARGET_A, TARGET_B]) {
    await engine.putPage(slug, {
      type: 'system' as never, title: slug, compiled_truth: '', timeline: '',
    });
  }
  await putPageOp({ slug: SUBJECT, content: BODY_WITH_UNRESOLVABLE_WIKILINKS });
  // Managed ('markdown') edges, as an earlier extraction pass left them.
  for (const to of [TARGET_A, TARGET_B]) {
    await engine.addLink(SUBJECT, to, 'seeded', 'mentions', 'markdown');
  }
}

async function outboundTargets() {
  const links = await engine.getLinks(SUBJECT);
  return links.map(l => l.to_slug).sort();
}

describe('put_page auto-link — unresolvable body refs are not destroyed', () => {
  test('a `skipped` (content-hash no-op) re-put leaves links untouched', async () => {
    await seedPageAndManagedEdges();
    expect(await outboundTargets()).toEqual(BOTH_TARGETS);

    // Byte-identical re-put → content-hash no-op.
    const res = await putPageOp({
      slug: SUBJECT,
      content: BODY_WITH_UNRESOLVABLE_WIKILINKS,
    });

    expect(res.status).toBe('skipped');
    expect(res.auto_links?.removed).toBe(0);
    expect(await outboundTargets()).toEqual(BOTH_TARGETS);
  }, 30_000);

  test('a genuine (non-skipped) rewrite that KEEPS the wikilinks leaves links untouched', async () => {
    await seedPageAndManagedEdges();
    expect(await outboundTargets()).toEqual(BOTH_TARGETS);

    const res = await putPageOp({
      slug: SUBJECT,
      content: BODY_WITH_UNRESOLVABLE_WIKILINKS.replace(
        'Compiled truth about put_page.',
        'Compiled truth about put_page. Revised paragraph.',
      ),
    });

    expect(res.status).toBe('created_or_updated');
    expect(res.auto_links?.removed).toBe(0);
    expect(await outboundTargets()).toEqual(BOTH_TARGETS);
  }, 30_000);

  test('withheld removals are reported, not silent', async () => {
    await seedPageAndManagedEdges();
    const res = await putPageOp({
      slug: SUBJECT,
      content: BODY_WITH_UNRESOLVABLE_WIKILINKS,
    });
    expect(res.auto_links?.withheld).toBe(2);
  }, 30_000);

  test('CONTRA: deleting the wikilink from the body still removes the edge', async () => {
    // The stale-edge contract must survive the fix. When the body genuinely
    // stops referencing the target there is no unresolvable ref to protect.
    await seedPageAndManagedEdges();
    expect(await outboundTargets()).toEqual(BOTH_TARGETS);

    const res = await putPageOp({
      slug: SUBJECT,
      content: `---
title: Write Semantics
type: system
---

No links here anymore.
`,
    });

    expect(res.auto_links?.removed).toBe(2);
    expect(await outboundTargets()).toEqual([]);
  }, 30_000);

  test('CONTRA: dropping ONE of two wikilinks removes only that edge', async () => {
    await seedPageAndManagedEdges();

    const res = await putPageOp({
      slug: SUBJECT,
      content: `---
title: Write Semantics
type: system
---

Compiled truth about put_page.

Related: [[${TARGET_B}]].
`,
    });

    expect(res.auto_links?.removed).toBe(1);
    expect(await outboundTargets()).toEqual([TARGET_B]);
  }, 30_000);

  test('manual edges stay untouched throughout (pre-existing contract)', async () => {
    await seedPageAndManagedEdges();
    await engine.addLink(SUBJECT, TARGET_B, 'hand-made', 'relates_to', 'manual');

    await putPageOp({
      slug: SUBJECT,
      content: `---
title: Write Semantics
type: system
---

No links here anymore.
`,
    });

    const links = await engine.getLinks(SUBJECT);
    expect(links.filter(l => l.link_source === 'manual').map(l => l.to_slug))
      .toEqual([TARGET_B]);
  }, 30_000);
});
