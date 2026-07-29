import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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
