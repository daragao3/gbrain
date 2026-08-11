import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const page = (title: string) => ({
  type: 'note',
  title,
  compiled_truth: `body:${title}`,
  timeline: '',
  frontmatter: {},
});

const markdown = (title: string, body: string, tags: string[] = []) => `---
type: note
title: ${title}
tags: [${tags.join(', ')}]
---

${body}
`;

async function stateFor(slug: string) {
  const [pageRow] = await engine.executeRaw<{
    id: number;
    title: string;
    compiled_truth: string;
    revision: number;
  }>(`
    SELECT p.id, p.title, p.compiled_truth, p.revision
    FROM pages p WHERE p.source_id = 'default' AND p.slug = $1
  `, [slug]);
  if (!pageRow) return null;
  const [versions, chunks, tags] = await Promise.all([
    engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM page_versions WHERE page_id = $1',
      [pageRow.id],
    ),
    engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1',
      [pageRow.id],
    ),
    engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM tags WHERE page_id = $1',
      [pageRow.id],
    ),
  ]);
  return {
    title: pageRow.title,
    compiled_truth: pageRow.compiled_truth,
    revision: pageRow.revision,
    versions: versions[0]?.n ?? 0,
    chunks: chunks[0]?.n ?? 0,
    tags: tags[0]?.n ?? 0,
  };
}

describe('conditional page writes', () => {
  test('createPageOnly creates revision 1 then conflicts without overwrite', async () => {
    const first = await engine.createPageOnly('notes/atomic', page('winner'), { sourceId: 'default' });
    expect(first.status).toBe('created');
    if (first.status !== 'created') throw new Error('expected created');
    expect(first.page.revision).toBe(1);

    const second = await engine.createPageOnly('notes/atomic', page('loser'), { sourceId: 'default' });
    expect(second).toEqual({
      status: 'conflict',
      slug: 'notes/atomic',
      reason: 'already_exists',
      current_revision: 1,
    });
    expect((await engine.getPage('notes/atomic'))?.title).toBe('winner');
  });

  test('createPageOnly reports soft_deleted tombstone', async () => {
    await engine.putPage('notes/tombstone', page('old'));
    await engine.softDeletePage('notes/tombstone', { sourceId: 'default' });
    const tombstone = await engine.getPage('notes/tombstone', { sourceId: 'default', includeDeleted: true });
    const result = await engine.createPageOnly('notes/tombstone', page('new'), { sourceId: 'default' });
    expect(result).toEqual({
      status: 'conflict',
      slug: 'notes/tombstone',
      reason: 'soft_deleted',
      current_revision: tombstone!.revision,
    });
  });

  test('lock + compareAndSwapPage updates only the expected active revision', async () => {
    const initial = await engine.putPage('notes/cas', page('v1'));
    const result = await engine.transaction(async tx => {
      const locked = await tx.lockPageForConditionalWrite('notes/cas', { sourceId: 'default' });
      expect(locked?.revision).toBe(initial.revision);
      return tx.compareAndSwapPage('notes/cas', page('v2'), initial.revision, { sourceId: 'default' });
    });
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') throw new Error('expected updated');
    expect(result.page.revision).toBe(initial.revision + 1);

    const stale = await engine.compareAndSwapPage('notes/cas', page('stale'), initial.revision, { sourceId: 'default' });
    expect(stale).toEqual({
      status: 'conflict',
      slug: 'notes/cas',
      reason: 'revision_mismatch',
      expected_revision: initial.revision,
      current_revision: initial.revision + 1,
    });
  });

  test('compareAndSwapPage reports missing page', async () => {
    const result = await engine.compareAndSwapPage('notes/missing', page('new'), 1, { sourceId: 'default' });
    expect(result).toEqual({
      status: 'conflict',
      slug: 'notes/missing',
      reason: 'not_found',
      expected_revision: 1,
    });
  });

  test('compareAndSwapPage reports soft-deleted tombstone', async () => {
    const initial = await engine.putPage('notes/deleted-cas', page('old'));
    await engine.softDeletePage('notes/deleted-cas', { sourceId: 'default' });
    const tombstone = await engine.getPage('notes/deleted-cas', { sourceId: 'default', includeDeleted: true });

    const result = await engine.compareAndSwapPage(
      'notes/deleted-cas',
      page('new'),
      initial.revision,
      { sourceId: 'default' },
    );
    expect(result).toEqual({
      status: 'conflict',
      slug: 'notes/deleted-cas',
      reason: 'soft_deleted',
      expected_revision: initial.revision,
      current_revision: tombstone!.revision,
    });
  });

  test('same slug in two sources has independent revision sequences', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('source-a', 'source-a', '{}'::jsonb), ('source-b', 'source-b', '{}'::jsonb)`,
    );

    const sourceA = await engine.createPageOnly('notes/shared', page('a1'), { sourceId: 'source-a' });
    const sourceB = await engine.createPageOnly('notes/shared', page('b1'), { sourceId: 'source-b' });
    expect(sourceA.status).toBe('created');
    expect(sourceB.status).toBe('created');
    if (sourceA.status !== 'created' || sourceB.status !== 'created') throw new Error('expected created');
    expect(sourceA.page.revision).toBe(1);
    expect(sourceB.page.revision).toBe(1);

    const updatedA = await engine.compareAndSwapPage('notes/shared', page('a2'), 1, { sourceId: 'source-a' });
    expect(updatedA.status).toBe('updated');
    if (updatedA.status !== 'updated') throw new Error('expected updated');
    expect(updatedA.page.revision).toBe(2);

    const lockedB = await engine.transaction(tx =>
      tx.lockPageForConditionalWrite('notes/shared', { sourceId: 'source-b' }),
    );
    expect(lockedB?.title).toBe('b1');
    expect(lockedB?.revision).toBe(1);
  });
});

describe('conditional import transaction', () => {
  test('create success writes page, tags, and chunks; repeated create leaves state unchanged', async () => {
    const content = markdown('Created', 'created body', ['alpha', 'beta']);
    const first = await importFromContent(engine, 'notes/import-create', content, {
      noEmbed: true,
      writePrecondition: { mode: 'create_only' },
    });
    expect(first.status).toBe('created');
    expect(first.revision).toBe(1);
    const afterCreate = await stateFor('notes/import-create');
    expect(afterCreate).toMatchObject({ title: 'Created', revision: 1, versions: 0, tags: 2 });
    expect(afterCreate!.chunks).toBeGreaterThan(0);

    const second = await importFromContent(
      engine,
      'notes/import-create',
      markdown('Loser', 'loser body', ['loser']),
      { noEmbed: true, writePrecondition: { mode: 'create_only' } },
    );
    expect(second).toMatchObject({
      status: 'conflict',
      reason: 'already_exists',
      current_revision: 1,
      chunks: 0,
    });
    expect(await stateFor('notes/import-create')).toEqual(afterCreate);
  });

  test('matching CAS snapshots once, updates projections, and increments revision once', async () => {
    const created = await importFromContent(
      engine,
      'notes/import-cas',
      markdown('Initial', 'initial body', ['old']),
      { noEmbed: true, writePrecondition: { mode: 'create_only' } },
    );
    expect(created.status).toBe('created');

    const updated = await importFromContent(
      engine,
      'notes/import-cas',
      markdown('Updated', 'updated body', ['new']),
      { noEmbed: true, writePrecondition: { mode: 'compare_and_swap', expected_revision: 1 } },
    );
    expect(updated.status).toBe('updated');
    expect(updated.revision).toBe(2);
    const state = await stateFor('notes/import-cas');
    expect(state).toMatchObject({ title: 'Updated', revision: 2, versions: 1, tags: 2 });
    expect(state!.chunks).toBeGreaterThan(0);
  });

  test('stale CAS leaves page, versions, tags, and chunks unchanged', async () => {
    await importFromContent(engine, 'notes/import-stale', markdown('Initial', 'initial body', ['old']), {
      noEmbed: true,
      writePrecondition: { mode: 'create_only' },
    });
    const before = await stateFor('notes/import-stale');

    const stale = await importFromContent(engine, 'notes/import-stale', markdown('Stale', 'stale body', ['new']), {
      noEmbed: true,
      writePrecondition: { mode: 'compare_and_swap', expected_revision: 0 },
    });
    expect(stale).toMatchObject({
      status: 'conflict',
      reason: 'revision_mismatch',
      expected_revision: 0,
      current_revision: 1,
      chunks: 0,
    });
    expect(await stateFor('notes/import-stale')).toEqual(before);
  });

  test('same-content matching CAS returns unchanged without version or projection writes', async () => {
    const content = markdown('Same', 'same body', ['same']);
    await importFromContent(engine, 'notes/import-same', content, {
      noEmbed: true,
      writePrecondition: { mode: 'create_only' },
    });
    const before = await stateFor('notes/import-same');

    const unchanged = await importFromContent(engine, 'notes/import-same', content, {
      noEmbed: true,
      writePrecondition: { mode: 'compare_and_swap', expected_revision: 1 },
    });
    expect(unchanged).toMatchObject({ status: 'unchanged', revision: 1, chunks: 0 });
    expect(await stateFor('notes/import-same')).toEqual(before);
  });

  test('missing and tombstoned CAS return distinct conflicts', async () => {
    const missing = await importFromContent(engine, 'notes/import-missing', markdown('Missing', 'body'), {
      noEmbed: true,
      writePrecondition: { mode: 'compare_and_swap', expected_revision: 1 },
    });
    expect(missing).toMatchObject({
      status: 'conflict',
      reason: 'not_found',
      expected_revision: 1,
    });

    await importFromContent(engine, 'notes/import-tombstone', markdown('Old', 'old body'), {
      noEmbed: true,
      writePrecondition: { mode: 'create_only' },
    });
    await engine.softDeletePage('notes/import-tombstone', { sourceId: 'default' });
    const tombstone = await engine.getPage('notes/import-tombstone', { sourceId: 'default', includeDeleted: true });
    const deleted = await importFromContent(engine, 'notes/import-tombstone', markdown('New', 'new body'), {
      noEmbed: true,
      writePrecondition: { mode: 'compare_and_swap', expected_revision: 1 },
    });
    expect(deleted).toMatchObject({
      status: 'conflict',
      reason: 'soft_deleted',
      expected_revision: 1,
      current_revision: tombstone!.revision,
    });
  });

  test('projection failure after page update rolls back page, revision, version, tags, and chunks', async () => {
    await importFromContent(engine, 'notes/import-rollback', markdown('Initial', 'initial body', ['old']), {
      noEmbed: true,
      writePrecondition: { mode: 'create_only' },
    });
    const before = await stateFor('notes/import-rollback');
    const originalAddTagDescriptor = Object.getOwnPropertyDescriptor(engine, 'addTag');
    const originalAddTag = engine.addTag;
    engine.addTag = async (...args: Parameters<typeof engine.addTag>) => {
      if (args[1] === 'explode') throw new Error('injected addTag failure');
      return originalAddTag.call(engine, ...args);
    };

    try {
      await expect(importFromContent(
        engine,
        'notes/import-rollback',
        markdown('Updated', 'updated body', ['explode']),
        { noEmbed: true, writePrecondition: { mode: 'compare_and_swap', expected_revision: 1 } },
      )).rejects.toThrow('injected addTag failure');
    } finally {
      if (originalAddTagDescriptor) {
        Object.defineProperty(engine, 'addTag', originalAddTagDescriptor);
      } else {
        delete (engine as unknown as { addTag?: typeof originalAddTag }).addTag;
      }
    }

    expect(await stateFor('notes/import-rollback')).toEqual(before);
  });

  test('chunk projection failure after create rolls back the inserted page', async () => {
    const originalUpsertChunksDescriptor = Object.getOwnPropertyDescriptor(engine, 'upsertChunks');
    engine.upsertChunks = async () => {
      throw new Error('injected upsertChunks failure');
    };

    try {
      await expect(importFromContent(
        engine,
        'notes/import-create-rollback',
        markdown('Created', 'created body', ['new']),
        { noEmbed: true, writePrecondition: { mode: 'create_only' } },
      )).rejects.toThrow('injected upsertChunks failure');
    } finally {
      if (originalUpsertChunksDescriptor) {
        Object.defineProperty(engine, 'upsertChunks', originalUpsertChunksDescriptor);
      } else {
        delete (engine as unknown as { upsertChunks?: typeof engine.upsertChunks }).upsertChunks;
      }
    }

    expect(await stateFor('notes/import-create-rollback')).toBeNull();
  });
});
