/**
 * Tests for the `entity_dirs_orphaned_edges` doctor check.
 *
 * Reports `fail` when the CURRENTLY EFFECTIVE `link_resolution.entity_dirs`
 * would leave existing deletable edges unextractable — i.e. runAutoLink is
 * armed to hard-delete them on the next local put_page, and `links` has no
 * tombstone column.
 *
 * Hermetic PGLite.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { checkEntityDirsOrphanedEdges } from '../src/commands/doctor.ts';

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

async function seedPage(slug: string, compiledTruth = ''): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at)
     VALUES ($1, 'default', 'concept', $1, $2, '', '{}'::jsonb, $1, now(), now())
     RETURNING id`,
    [slug, compiledTruth],
  );
  return rows[0].id;
}

async function seedMarkdownLink(fromId: number, toId: number): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source, created_at)
     VALUES ($1, $2, 'mentions', 'markdown', now())`,
    [fromId, toId],
  );
}

/** Page whose four edges all sit under sessions/ + systems/ — the 2026-08-10 shape. */
async function seedTheHazard(): Promise<void> {
  const body = [
    'References [[sessions/2026-07-17-backlog-sweep]] and',
    '[[sessions/2026-07-09-http-cutover]] plus [[systems/widget-service]]',
    'and [[systems/acme-relay]].',
  ].join('\n');
  const from = await seedPage('systems/write-semantics', body);
  for (const t of [
    'sessions/2026-07-17-backlog-sweep',
    'sessions/2026-07-09-http-cutover',
    'systems/widget-service',
    'systems/acme-relay',
  ]) {
    await seedMarkdownLink(from, await seedPage(t));
  }
}

describe('entity_dirs_orphaned_edges doctor check', () => {
  test('empty brain → ok', async () => {
    const c = await checkEntityDirsOrphanedEdges(engine);
    expect(c.name).toBe('entity_dirs_orphaned_edges');
    expect(c.status).toBe('ok');
  });

  test('prefixes declared → ok', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems');

    const c = await checkEntityDirsOrphanedEdges(engine);
    expect(c.status).toBe('ok');
  });

  test('prefixes undeclared → fail, naming count, prefixes and the remedy', async () => {
    await seedTheHazard();
    // No entity_dirs configured at all: all four edges are armed.
    const c = await checkEntityDirsOrphanedEdges(engine);

    expect(c.status).toBe('fail');
    expect(c.message).toContain('4');
    expect(c.message).toContain('sessions');
    expect(c.message).toContain('systems');
    // Paste-ready remedy, with the missing prefixes already in it.
    expect(c.message).toContain('gbrain config set link_resolution.entity_dirs');
    // Names a concrete page so the operator can verify before acting.
    expect(c.message).toContain('systems/write-semantics');
  });

  test('the remedy preserves prefixes that are already declared', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions');

    const c = await checkEntityDirsOrphanedEdges(engine);
    expect(c.status).toBe('fail');
    // Only systems/ is missing, but the paste-ready command must re-set the
    // FULL list — a remedy that drops `sessions` would arm a new hazard.
    const cmd = c.message.slice(c.message.indexOf('gbrain config set'));
    expect(cmd).toContain('sessions');
    expect(cmd).toContain('systems');
  });

  test('honours the env override, because that is what extraction reads', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems');

    // getExtraEntityDirs prefers the env var over the DB plane, so a narrower
    // env value silently re-arms the hazard. The check must see that.
    await withEnv({ GBRAIN_LINK_RESOLUTION_ENTITY_DIRS: 'sessions' }, async () => {
      const c = await checkEntityDirsOrphanedEdges(engine);
      expect(c.status).toBe('fail');
      expect(c.message).toContain('systems');
    });

    const after = await checkEntityDirsOrphanedEdges(engine);
    expect(after.status).toBe('ok');
  });

  test('details carry the machine-readable breakdown', async () => {
    await seedTheHazard();
    const c = await checkEntityDirsOrphanedEdges(engine);
    expect(c.details).toMatchObject({
      at_risk_edges: 4,
      pages_affected: 1,
      missing_prefixes: ['sessions', 'systems'],
    });
  });
});
