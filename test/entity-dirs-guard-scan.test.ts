/**
 * Tests for `scanOrphanedMarkdownEdges` — the DB half of the entity_dirs
 * safety guard.
 *
 * An edge is AT RISK when a page's prose still carries the reference under a
 * prefix the current `entity_dirs` no longer declares, AND a real
 * `link_source='markdown'` edge backs that reference. The next local put_page
 * re-extracts, misses the reference, and hard-deletes the edge.
 *
 * The intersection against real edges is what keeps the wildcard detector's
 * over-reporting out of the findings, so it is asserted directly.
 *
 * Hermetic PGLite; pages and links are seeded by raw SQL.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  scanOrphanedMarkdownEdges,
  prefixesRemovedBy,
} from '../src/core/entity-dirs-guard.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedPage(slug: string, compiledTruth = '', timeline = ''): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at)
     VALUES ($1, 'default', 'concept', $1, $2, $3, '{}'::jsonb, $1, now(), now())
     RETURNING id`,
    [slug, compiledTruth, timeline],
  );
  return rows[0].id;
}

async function seedLink(
  fromId: number,
  toId: number,
  linkSource: string | null = 'markdown',
  linkType = 'mentions',
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source, created_at)
     VALUES ($1, $2, $3, $4, now())`,
    [fromId, toId, linkType, linkSource],
  );
}

describe('prefixesRemovedBy', () => {
  test('names the prefixes present in current but absent from proposed', () => {
    expect(prefixesRemovedBy(['sessions', 'systems', 'infra'], ['sessions'])).toEqual([
      'infra',
      'systems',
    ]);
  });

  test('adding a prefix removes nothing', () => {
    expect(prefixesRemovedBy(['sessions'], ['sessions', 'systems'])).toEqual([]);
  });

  test('clearing the config removes everything currently declared', () => {
    expect(prefixesRemovedBy(['sessions', 'systems'], [])).toEqual(['sessions', 'systems']);
  });

  test('normalizes both sides, so case and spacing never fake a removal', () => {
    expect(prefixesRemovedBy(['sessions'], ['  SESSIONS  '])).toEqual([]);
  });

  test('a canonical default is never reported as removed', () => {
    // DEFAULT_ENTITY_DIRS is not operator-controlled; dropping it from the
    // operator list changes nothing, so claiming a removal would be a lie.
    expect(prefixesRemovedBy(['people', 'sessions'], [])).toEqual(['sessions']);
  });
});

describe('scanOrphanedMarkdownEdges', () => {
  test('empty brain → nothing at risk', async () => {
    const r = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(r.atRisk).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  test('undeclared prefix WITH a backing markdown edge → at risk', async () => {
    const from = await seedPage('systems/write-semantics', 'See [[sessions/cutover]].');
    const to = await seedPage('sessions/cutover');
    await seedLink(from, to);

    const r = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(r.atRisk).toHaveLength(1);
    expect(r.atRisk[0]).toMatchObject({
      fromSlug: 'systems/write-semantics',
      toSlug: 'sessions/cutover',
      dir: 'sessions',
    });
    expect(r.byPrefix).toEqual({ sessions: 1 });
  });

  test('the same prefix declared → nothing at risk', async () => {
    const from = await seedPage('systems/write-semantics', 'See [[sessions/cutover]].');
    const to = await seedPage('sessions/cutover');
    await seedLink(from, to);

    const r = await scanOrphanedMarkdownEdges(engine, { entityDirs: ['sessions'] });
    expect(r.atRisk).toEqual([]);
  });

  test('undeclared prefix with NO backing edge → not reported', async () => {
    // This is the wildcard detector's over-reporting. It must not surface: the
    // reference is unextractable, but there is no edge to lose.
    await seedPage('systems/write-semantics', 'See [[sessions/cutover]].');
    await seedPage('sessions/cutover');

    const r = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(r.atRisk).toEqual([]);
  });

  test('a manual edge under an undeclared prefix → not reported', async () => {
    // reconcilableOut never admits link_source='manual', so runAutoLink cannot
    // delete it. Reporting it would send the operator after a non-problem.
    const from = await seedPage('systems/x', 'See [[sessions/cutover]].');
    const to = await seedPage('sessions/cutover');
    await seedLink(from, to, 'manual');

    const r = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(r.atRisk).toEqual([]);
  });

  test('a NULL-link_source edge IS reported', async () => {
    // reconcilableOut admits link_source IS NULL, so these are deletable too.
    const from = await seedPage('systems/x', 'See [[sessions/cutover]].');
    const to = await seedPage('sessions/cutover');
    await seedLink(from, to, null);

    const r = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(r.atRisk).toHaveLength(1);
  });

  test('timeline content counts, not just compiled_truth', async () => {
    // runAutoLink extracts from compiled_truth + '\n' + timeline.
    const from = await seedPage('systems/x', 'Nothing here.', 'Later: [[sessions/cutover]].');
    const to = await seedPage('sessions/cutover');
    await seedLink(from, to);

    const r = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(r.atRisk).toHaveLength(1);
  });

  test('a soft-deleted page is not scanned', async () => {
    const from = await seedPage('systems/x', 'See [[sessions/cutover]].');
    const to = await seedPage('sessions/cutover');
    await seedLink(from, to);
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = $1`, [from]);

    const r = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(r.atRisk).toEqual([]);
  });

  test('onlyPrefixes narrows the finding to the prefixes being removed', async () => {
    const from = await seedPage('systems/x', 'See [[sessions/cutover]] and [[infra/db]].');
    const s = await seedPage('sessions/cutover');
    const i = await seedPage('infra/db');
    await seedLink(from, s);
    await seedLink(from, i);

    const all = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(all.atRisk).toHaveLength(2);

    const narrowed = await scanOrphanedMarkdownEdges(engine, {
      entityDirs: [],
      onlyPrefixes: ['infra'],
    });
    expect(narrowed.atRisk).toHaveLength(1);
    expect(narrowed.atRisk[0].dir).toBe('infra');
  });

  test('a row cap reports truncated instead of silently sampling', async () => {
    // The page-body query is unbounded by default; a brain with very many
    // linked pages would load every body at once. The cap bounds that, and a
    // capped run must SAY it was capped — a silently-sampled safety check
    // reads as "covered everything".
    for (const n of ['a', 'b', 'c']) {
      const from = await seedPage(`systems/${n}`, `See [[sessions/t-${n}]].`);
      await seedLink(from, await seedPage(`sessions/t-${n}`));
    }

    const capped = await scanOrphanedMarkdownEdges(engine, { entityDirs: [], maxPages: 1 });
    expect(capped.truncated).toBe(true);
    expect(capped.pagesScanned).toBe(1);
    expect(capped.atRisk).toHaveLength(1);

    const full = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(full.truncated).toBe(false);
    expect(full.atRisk).toHaveLength(3);
  });

  test('the 2026-08-10 shape: four edges under two undeclared prefixes', async () => {
    const body = [
      'Compiled truth references [[sessions/2026-07-17-backlog-sweep]]',
      'and [[sessions/2026-07-09-http-cutover]] plus',
      '[[systems/widget-service]] and [[systems/acme-relay]].',
    ].join('\n');
    const from = await seedPage('systems/write-semantics', body);
    for (const t of [
      'sessions/2026-07-17-backlog-sweep',
      'sessions/2026-07-09-http-cutover',
      'systems/widget-service',
      'systems/acme-relay',
    ]) {
      await seedLink(from, await seedPage(t));
    }

    // Config as it stands today: both prefixes declared, hazard disarmed.
    const declared = await scanOrphanedMarkdownEdges(engine, {
      entityDirs: ['sessions', 'systems'],
    });
    expect(declared.atRisk).toEqual([]);

    // Drop them and all four edges are armed for an unrecoverable delete.
    const dropped = await scanOrphanedMarkdownEdges(engine, { entityDirs: [] });
    expect(dropped.atRisk).toHaveLength(4);
    expect(dropped.byPrefix).toEqual({ sessions: 2, systems: 2 });
    expect(dropped.pagesAffected).toBe(1);
  });
});
