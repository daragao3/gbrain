/**
 * Regression — the removal safety net must cover ALL FOUR reference shapes,
 * not just the generic `[[wikilink]]`.
 *
 * v0.42.80.0 shipped `PageLinksResult.unresolvableRefs` → `protectedLiterals`
 * → `auto_links.withheld`, which stops a local `put_page` from hard-deleting
 * managed edges whose target is still referenced in the body. But
 * `unresolvableRefs` was pushed only inside `extractPageLinks`'s
 * `ref.needsResolution` branch, and only the generic `[[bare-name]]` wikilink
 * pass ever sets that flag.
 *
 * Probed against the v0.42.81.0 extractor with `entityDirs: []` and
 * `globalBasename: false`, control listed first:
 *
 *   [[sessions/foo]]        candidates=0  unresolvableRefs=["sessions/foo"]  PROTECTED
 *   [x](sessions/foo)       candidates=0  unresolvableRefs=[]                EXPOSED
 *   bare sessions/foo       candidates=0  unresolvableRefs=[]                EXPOSED
 *   [[wiki:sessions/foo]]   candidates=0  unresolvableRefs=[]                EXPOSED
 *
 * The three exposed shapes miss the dir-gated regexes entirely, so they never
 * become a ref and never reach the net — their `link_source='markdown'` edges
 * were still hard-deleted, and `links` has no tombstone column.
 *
 * The fix routes the whole body through `extractUndeclaredPrefixRefs` (the
 * v0.42.81.0 wildcard-prefix matcher, which already recognises all four shapes
 * and already guards `https://example.com/sessions/x` against reading as a
 * `com/sessions/x` ref) and folds its hits into `unresolvableRefs`.
 *
 * Each shape below is pinned by a pair:
 *   - the reference is PRESENT → the edge survives, and the withheld removal
 *     is reported rather than silent;
 *   - CONTRA, the reference is GONE → the edge is still removed. Trading the
 *     deletion bug for a stale-edge bug would be no fix at all, so every shape
 *     pays that toll explicitly.
 *
 * The generic-wikilink shape keeps its own coverage in the sibling file
 * `put-page-autolink-unresolvable-refs-pglite.test.ts`; it appears here only
 * as the control that proves this harness can see a protected shape at all.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 120_000);

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

// `notes/` and `archive/` are deliberately OUTSIDE DIR_PATTERN and are not
// declared in `link_resolution.entity_dirs` — that is the whole point. A
// `[[people/...]]` reference extracts normally and never reaches this path.
const SUBJECT = 'notes/write-semantics';
const TARGET_A = 'notes/prior-session';
const TARGET_B = 'archive/legacy-note';
const BOTH_TARGETS = [TARGET_B, TARGET_A].sort();

function body(relatedLine: string): string {
  return `---
title: Write Semantics
type: system
---

Compiled truth about put_page.

${relatedLine}
`;
}

/** Body with no reference to either target, in any shape. */
const BODY_NO_REFS = body('No links here anymore.');

/**
 * The four shapes, each rendered for one or both targets. `both` carries a
 * reference to TARGET_A and TARGET_B; `onlyB` drops TARGET_A so the partial
 * CONTRA can prove removal is per-edge, not all-or-nothing.
 */
const SHAPES = [
  {
    name: 'generic wikilink (control — already covered by v0.42.80.0)',
    both: `Related: [[${TARGET_A}]] and [[${TARGET_B}]].`,
    onlyB: `Related: [[${TARGET_B}]].`,
  },
  {
    name: 'markdown link [label](dir/slug)',
    both: `Related: [Prior](${TARGET_A}) and [Legacy](${TARGET_B}).`,
    onlyB: `Related: [Legacy](${TARGET_B}).`,
  },
  {
    name: 'bare slug dir/slug',
    both: `Related: ${TARGET_A} and ${TARGET_B}.`,
    onlyB: `Related: ${TARGET_B}.`,
  },
  {
    name: 'qualified wikilink [[source:dir/slug]]',
    both: `Related: [[wiki:${TARGET_A}]] and [[wiki:${TARGET_B}]].`,
    onlyB: `Related: [[wiki:${TARGET_B}]].`,
  },
] as const;

/**
 * Seed both target pages, write the subject, then add the managed
 * (`link_source='markdown'`) edges an earlier extraction pass would have left.
 * Seeding the edges directly is what makes this a reconciliation test rather
 * than an extraction test — the edges exist no matter which shape the body uses.
 */
async function seedPageAndManagedEdges(subjectBody: string) {
  for (const slug of [TARGET_A, TARGET_B]) {
    await engine.putPage(slug, {
      type: 'system' as never, title: slug, compiled_truth: '', timeline: '',
    });
  }
  await putPageOp({ slug: SUBJECT, content: subjectBody });
  for (const to of [TARGET_A, TARGET_B]) {
    await engine.addLink(SUBJECT, to, 'seeded', 'mentions', 'markdown');
  }
}

async function outboundTargets() {
  const links = await engine.getLinks(SUBJECT);
  return links.map(l => l.to_slug).sort();
}

describe('put_page auto-link — every reference shape withholds the removal', () => {
  for (const shape of SHAPES) {
    describe(shape.name, () => {
      test('a `skipped` (content-hash no-op) re-put leaves the edges intact', async () => {
        const content = body(shape.both);
        await seedPageAndManagedEdges(content);
        expect(await outboundTargets()).toEqual(BOTH_TARGETS);

        const res = await putPageOp({ slug: SUBJECT, content });

        expect(res.status).toBe('skipped');
        expect(res.auto_links?.removed).toBe(0);
        expect(await outboundTargets()).toEqual(BOTH_TARGETS);
      }, 60_000);

      test('a genuine rewrite that KEEPS the references leaves the edges intact', async () => {
        const content = body(shape.both);
        await seedPageAndManagedEdges(content);
        expect(await outboundTargets()).toEqual(BOTH_TARGETS);

        const res = await putPageOp({
          slug: SUBJECT,
          content: content.replace(
            'Compiled truth about put_page.',
            'Compiled truth about put_page. Revised paragraph.',
          ),
        });

        expect(res.status).toBe('created_or_updated');
        expect(res.auto_links?.removed).toBe(0);
        expect(await outboundTargets()).toEqual(BOTH_TARGETS);
      }, 60_000);

      test('the withheld removals are reported, not silent', async () => {
        const content = body(shape.both);
        await seedPageAndManagedEdges(content);

        const res = await putPageOp({ slug: SUBJECT, content });

        expect(res.auto_links?.withheld).toBe(2);
      }, 60_000);

      test('CONTRA: deleting the references still removes both edges', async () => {
        await seedPageAndManagedEdges(body(shape.both));
        expect(await outboundTargets()).toEqual(BOTH_TARGETS);

        const res = await putPageOp({ slug: SUBJECT, content: BODY_NO_REFS });

        expect(res.auto_links?.removed).toBe(2);
        expect(res.auto_links?.withheld).toBe(0);
        expect(await outboundTargets()).toEqual([]);
      }, 60_000);

      test('CONTRA: dropping ONE of two references removes only that edge', async () => {
        await seedPageAndManagedEdges(body(shape.both));

        const res = await putPageOp({ slug: SUBJECT, content: body(shape.onlyB) });

        expect(res.auto_links?.removed).toBe(1);
        expect(await outboundTargets()).toEqual([TARGET_B]);
      }, 60_000);
    });
  }

  test('a reference inside a URL does NOT protect the edge', async () => {
    // The bare-slug arm can start at any path segment, so
    // `https://example.com/notes/prior-session` would otherwise read as a
    // reference and pin the edge forever. `URL_CONTEXT_CHAR_RE` is what stops
    // that, and this is the test that would catch its removal.
    await seedPageAndManagedEdges(body(`Related: [[${TARGET_A}]] and [[${TARGET_B}]].`));

    const res = await putPageOp({
      slug: SUBJECT,
      content: body(`See https://example.com/${TARGET_A} and https://example.com/${TARGET_B}.`),
    });

    expect(res.auto_links?.removed).toBe(2);
    expect(await outboundTargets()).toEqual([]);
  }, 60_000);

  test('a reference inside a code span does NOT protect the edge', async () => {
    // `stripCodeBlocks` runs before every pass, including the new one. A slug
    // quoted in a code fence is a code sample, not a reference.
    await seedPageAndManagedEdges(body(`Related: [[${TARGET_A}]] and [[${TARGET_B}]].`));

    const res = await putPageOp({
      slug: SUBJECT,
      content: body('Example: `' + TARGET_A + '` and `' + TARGET_B + '`.'),
    });

    expect(res.auto_links?.removed).toBe(2);
    expect(await outboundTargets()).toEqual([]);
  }, 60_000);

  test('manual edges stay untouched regardless of shape', async () => {
    await seedPageAndManagedEdges(body(`Related: [Prior](${TARGET_A}) and [Legacy](${TARGET_B}).`));
    await engine.addLink(SUBJECT, TARGET_B, 'hand-made', 'relates_to', 'manual');

    await putPageOp({ slug: SUBJECT, content: BODY_NO_REFS });

    const links = await engine.getLinks(SUBJECT);
    expect(links.filter(l => l.link_source === 'manual').map(l => l.to_slug))
      .toEqual([TARGET_B]);
  }, 60_000);
});
