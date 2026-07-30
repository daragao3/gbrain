import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent, type ImportResult } from '../../src/core/import-file.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = hasDatabase() ? describe : describe.skip;
const WRITER_COUNT = 4;
const DISPOSABLE_DATABASE_NAME = /^task5_test_[0-9a-f]{8}$/;

function assertDisposableDatabaseName(databaseName: string): void {
  if (databaseName === 'gbrain_db' || !DISPOSABLE_DATABASE_NAME.test(databaseName)) {
    throw new Error(
      `E2E guard: selected database name is not an approved disposable Task 5 database; refusing to run.`,
    );
  }
}

describe('conditional-write PostgreSQL database identity guard', () => {
  test('accepts only the suite disposable database naming shape', () => {
    expect(() => assertDisposableDatabaseName('task5_test_a491e265')).not.toThrow();

    for (const name of [
      'gbrain_db',
      'gbrain_test',
      'task5_test',
      'task5_test_not-hex',
      'other_test_a491e265',
    ]) {
      expect(() => assertDisposableDatabaseName(name)).toThrow(/refusing to run/);
    }
  });
});

describe('conditional-write PostgreSQL writer setup', () => {
  test('disconnects engines connected before a later writer rejects', async () => {
    const disconnected: number[] = [];
    const failure = new Error('injected writer connection failure');
    const connect = async (engine: PostgresEngine, index: number) => {
      if (index === 2) throw failure;
      engine.disconnect = async () => {
        disconnected.push(index);
      };
    };

    await expect(connectWriters(connect)).rejects.toBe(failure);
    expect(disconnected.sort()).toEqual([0, 1]);
  });
});

const DATA_TABLES = [
  'facts',
  'synthesis_evidence',
  'takes',
  'content_chunks',
  'links',
  'tags',
  'raw_data',
  'timeline_entries',
  'page_versions',
  'ingest_log',
  'files',
  'context_volunteer_events',
  'pages',
  'sources',
];

function barrier(parties: number) {
  let waiting = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    waiting += 1;
    if (waiting === parties) release();
    await ready;
  };
}

const markdown = (writer: string, phase: string) => `---
type: note
title: ${phase}-${writer}
tags: [${phase}, writer-${writer}]
---

body:${phase}:${writer}
`;

type Snapshot = {
  title: string;
  compiledTruth: string;
  revision: number;
  deleted: boolean;
  tags: string[];
  chunks: string[];
  versions: Array<{ compiledTruth: string; frontmatterTitle: string | null }>;
};

async function snapshot(engine: PostgresEngine, slug: string, sourceId = 'default'): Promise<Snapshot | null> {
  const pageRows = await engine.executeRaw<{
    id: number;
    title: string;
    compiled_truth: string;
    revision: number;
    deleted: boolean;
  }>(
    `SELECT id, title, compiled_truth, revision, deleted_at IS NOT NULL AS deleted
       FROM pages WHERE source_id = $1 AND slug = $2`,
    [sourceId, slug],
  );
  const page = pageRows[0];
  if (!page) return null;

  const [tagRows, chunkRows, versionRows] = await Promise.all([
    engine.executeRaw<{ tag: string }>(
      'SELECT tag FROM tags WHERE page_id = $1 ORDER BY tag',
      [page.id],
    ),
    engine.executeRaw<{ chunk_text: string }>(
      'SELECT chunk_text FROM content_chunks WHERE page_id = $1 ORDER BY chunk_index',
      [page.id],
    ),
    engine.executeRaw<{ compiled_truth: string; frontmatter_title: string | null }>(
      `SELECT compiled_truth, frontmatter->>'title' AS frontmatter_title
         FROM page_versions WHERE page_id = $1 ORDER BY id`,
      [page.id],
    ),
  ]);

  return {
    title: page.title,
    compiledTruth: page.compiled_truth,
    revision: Number(page.revision),
    deleted: page.deleted,
    tags: tagRows.map(row => row.tag),
    chunks: chunkRows.map(row => row.chunk_text),
    versions: versionRows.map(row => ({
      compiledTruth: row.compiled_truth,
      frontmatterTitle: row.frontmatter_title,
    })),
  };
}

function expectWinnerState(
  state: Snapshot,
  writer: string,
  phase: string,
  expectedTags: string[] = [phase, `writer-${writer}`],
) {
  expect(state.title).toBe(`${phase}-${writer}`);
  expect(state.compiledTruth).toContain(`body:${phase}:${writer}`);
  expect(state.tags).toEqual([...expectedTags].sort());
  expect(state.chunks.length).toBeGreaterThan(0);
  expect(state.chunks.join('\n')).toContain(`body:${phase}:${writer}`);
  for (const loser of Array.from({ length: WRITER_COUNT }, (_, index) => String(index)).filter(id => id !== writer)) {
    expect(state.title).not.toContain(`${phase}-${loser}`);
    expect(state.compiledTruth).not.toContain(`body:${phase}:${loser}`);
    if (!expectedTags.includes(`writer-${loser}`)) {
      expect(state.tags).not.toContain(`writer-${loser}`);
    }
    expect(state.chunks.join('\n')).not.toContain(`body:${phase}:${loser}`);
  }
}

async function assertDisposableDatabaseSelected(): Promise<void> {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  const guardConnection = postgres(DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });
  try {
    const rows = await guardConnection<{ database_name: string }[]>`
      SELECT current_database() AS database_name
    `;
    const databaseName = rows[0]?.database_name;
    if (!databaseName) {
      throw new Error('E2E guard: current_database() returned no database name; refusing to run.');
    }
    assertDisposableDatabaseName(databaseName);
  } finally {
    await guardConnection.end({ timeout: 5 });
  }
}

async function connectWriters(
  connect: (engine: PostgresEngine, index: number) => Promise<void> = async engine => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    await engine.connect({ database_url: DATABASE_URL, poolSize: 1 });
  },
): Promise<PostgresEngine[]> {
  const connected: PostgresEngine[] = [];
  try {
    for (let index = 0; index < WRITER_COUNT; index++) {
      const engine = new PostgresEngine();
      await connect(engine, index);
      connected.push(engine);
    }
    return connected;
  } catch (error) {
    await Promise.all(connected.map(engine => engine.disconnect()));
    throw error;
  }
}

async function truncateData(engine: PostgresEngine) {
  for (const table of DATA_TABLES) {
    try {
      await engine.executeRaw(`TRUNCATE ${table} RESTART IDENTITY CASCADE`);
    } catch (error) {
      if ((error as { code?: string }).code !== '42P01') throw error;
    }
  }
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('default', 'default', '{"federated": true}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
}

function statuses(results: ImportResult[]) {
  return results.map(result => result.status);
}

class ProjectionFailureEngine extends PostgresEngine {
  override async transaction<T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
    const conn = this.sql;
    return conn.begin(async tx => {
      const txEngine = Object.create(this) as PostgresEngine;
      Object.defineProperty(txEngine, 'sql', { get: () => tx });
      Object.defineProperty(txEngine, '_sql', { value: tx, writable: false });
      Object.defineProperty(txEngine, 'upsertChunks', {
        value: async () => { throw new Error('injected projection failure'); },
      });
      return fn(txEngine);
    }) as Promise<T>;
  }
}

describeE2E('conditional page writes on real PostgreSQL', () => {
  let observer: PostgresEngine;
  let writers: PostgresEngine[] = [];

  beforeAll(async () => {
    await assertDisposableDatabaseSelected();
    observer = await setupDB();
    writers = await connectWriters();
  }, 60_000);

  beforeEach(async () => {
    await truncateData(observer);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(writers.map(engine => engine.disconnect()));
    await teardownDB();
  });

  test('four independent connections serialize create-only and CAS projections around one winner', async () => {
    const slug = 'test/concurrent-conditional';
    const createTogether = barrier(WRITER_COUNT);
    const creates = await Promise.all(writers.map(async (engine, index) => {
      await createTogether();
      return importFromContent(engine, slug, markdown(String(index), 'create'), {
        noEmbed: true,
        sourceId: 'default',
        writePrecondition: { mode: 'create_only' },
      });
    }));

    expect(statuses(creates).filter(status => status === 'created')).toHaveLength(1);
    const createConflicts = creates.filter(result => result.status === 'conflict');
    expect(createConflicts).toHaveLength(3);
    for (const conflict of createConflicts) {
      expect(conflict).toMatchObject({
        reason: 'already_exists',
        current_revision: 1,
        chunks: 0,
      });
    }

    const createWinner = String(creates.findIndex(result => result.status === 'created'));
    const created = await snapshot(observer, slug);
    expect(created).not.toBeNull();
    expect(created!.revision).toBe(1);
    expect(created!.versions).toEqual([]);
    expectWinnerState(created!, createWinner, 'create');

    const casTogether = barrier(WRITER_COUNT);
    const updates = await Promise.all(writers.map(async (engine, index) => {
      await casTogether();
      return importFromContent(engine, slug, markdown(String(index), 'cas'), {
        noEmbed: true,
        sourceId: 'default',
        writePrecondition: { mode: 'compare_and_swap', expected_revision: 1 },
      });
    }));

    expect(statuses(updates).filter(status => status === 'updated')).toHaveLength(1);
    const casConflicts = updates.filter(result => result.status === 'conflict');
    expect(casConflicts).toHaveLength(3);
    for (const conflict of casConflicts) {
      expect(conflict).toMatchObject({
        reason: 'revision_mismatch',
        expected_revision: 1,
        current_revision: 2,
        chunks: 0,
      });
    }

    const casWinner = String(updates.findIndex(result => result.status === 'updated'));
    const updated = await snapshot(observer, slug);
    expect(updated).not.toBeNull();
    expect(updated!.revision).toBe(2);
    expect(updated!.versions).toHaveLength(1);
    expect(updated!.versions[0]).toEqual({
      compiledTruth: created!.compiledTruth,
      frontmatterTitle: null,
    });
    expectWinnerState(updated!, casWinner, 'cas', [
      'create',
      `writer-${createWinner}`,
      'cas',
      `writer-${casWinner}`,
    ].filter((tag, index, all) => all.indexOf(tag) === index));
  }, 30_000);

  test('same slug remains isolated across two complete source-qualified pipelines and tombstone conflict', async () => {
    await observer.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('source-a', 'source-a', '{}'::jsonb), ('source-b', 'source-b', '{}'::jsonb)`,
    );
    const slug = 'test/shared-source-slug';

    const [sourceA, sourceB] = await Promise.all([
      importFromContent(writers[0]!, slug, markdown('a', 'source-create'), {
        noEmbed: true,
        sourceId: 'source-a',
        writePrecondition: { mode: 'create_only' },
      }),
      importFromContent(writers[1]!, slug, markdown('b', 'source-create'), {
        noEmbed: true,
        sourceId: 'source-b',
        writePrecondition: { mode: 'create_only' },
      }),
    ]);
    expect(sourceA).toMatchObject({ status: 'created', revision: 1 });
    expect(sourceB).toMatchObject({ status: 'created', revision: 1 });

    const createdA = await snapshot(observer, slug, 'source-a');
    expect(createdA).not.toBeNull();
    expect(createdA).toMatchObject({ revision: 1, deleted: false, versions: [] });
    expectWinnerState(createdA!, 'a', 'source-create');

    const beforeB = await snapshot(observer, slug, 'source-b');
    expect(beforeB).not.toBeNull();
    expect(beforeB).toMatchObject({ revision: 1, deleted: false, versions: [] });
    expectWinnerState(beforeB!, 'b', 'source-create');

    expect(await observer.softDeletePage(slug, { sourceId: 'source-a' })).toEqual({ slug });
    const tombstonedA = await snapshot(observer, slug, 'source-a');
    expect(tombstonedA).not.toBeNull();
    expect(tombstonedA).toMatchObject({
      title: createdA!.title,
      compiledTruth: createdA!.compiledTruth,
      revision: 2,
      deleted: true,
      tags: createdA!.tags,
      chunks: createdA!.chunks,
      versions: createdA!.versions,
    });

    const tombstone = await importFromContent(observer, slug, markdown('a-new', 'source-conflict'), {
      noEmbed: true,
      sourceId: 'source-a',
      writePrecondition: { mode: 'create_only' },
    });
    expect(tombstone).toMatchObject({
      status: 'conflict',
      reason: 'soft_deleted',
      current_revision: 2,
      chunks: 0,
    });

    expect(await snapshot(observer, slug, 'source-a')).toEqual(tombstonedA);
    expect(await snapshot(observer, slug, 'source-b')).toEqual(beforeB);
  });

  test('numeric v125 bootstrap installs exact v126 revision column, function, and trigger', async () => {
    await observer.executeRaw('DROP TRIGGER IF EXISTS bump_page_revision_trg ON pages');
    await observer.executeRaw('DROP FUNCTION IF EXISTS bump_page_revision_fn');
    await observer.executeRaw('ALTER TABLE pages DROP COLUMN IF EXISTS revision');
    await observer.setConfig('version', '125');

    const migration = MIGRATIONS.find(candidate => candidate.version === 126);
    const appliedIdentities: Array<{ version: number; name: string }> = [];
    const transaction = observer.transaction.bind(observer);
    observer.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>) => transaction(async tx => {
      const runMigration = tx.runMigration.bind(tx);
      tx.runMigration = async (version: number, sql: string) => {
        if (version === migration?.version && sql === migration.sql) {
          appliedIdentities.push({ version, name: migration.name });
        }
        await runMigration(version, sql);
      };
      return fn(tx);
    });

    const result = await runMigrations(observer);

    expect(LATEST_VERSION).toBe(126);
    expect(result).toEqual({ applied: 1, current: 126 });
    expect(appliedIdentities).toEqual([{ version: 126, name: 'page_revision_cas' }]);
    expect(await observer.getConfig('version')).toBe('126');
    const columns = await observer.executeRaw<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'pages'
          AND column_name = 'revision'`,
    );
    expect(columns).toEqual([{
      data_type: 'bigint',
      is_nullable: 'NO',
      column_default: '1',
    }]);

    const functions = await observer.executeRaw<{ name: string }>(
      `SELECT p.proname AS name
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.proname = 'bump_page_revision_fn'`,
    );
    expect(functions).toEqual([{ name: 'bump_page_revision_fn' }]);

    const triggers = await observer.executeRaw<{ name: string; enabled: string }>(
      `SELECT tgname AS name, tgenabled AS enabled
         FROM pg_trigger
        WHERE tgrelid = 'pages'::regclass
          AND tgname = 'bump_page_revision_trg'
          AND NOT tgisinternal`,
    );
    expect(triggers).toEqual([{ name: 'bump_page_revision_trg', enabled: 'O' }]);
  }, 60_000);
});

describeE2E('conditional page rollback on real PostgreSQL', () => {
  let observer: PostgresEngine;
  let failingEngine: ProjectionFailureEngine;

  beforeAll(async () => {
    await assertDisposableDatabaseSelected();
    observer = await setupDB();
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    failingEngine = new ProjectionFailureEngine();
    await failingEngine.connect({ database_url: DATABASE_URL, poolSize: 1 });
  }, 60_000);

  afterAll(async () => {
    await failingEngine.disconnect();
    await teardownDB();
  });

  test('dependent projection failure rolls back page, revision, version, tags, and chunks', async () => {
    const slug = 'test/postgres-rollback';
    const initial = await importFromContent(observer, slug, markdown('initial', 'rollback'), {
      noEmbed: true,
      sourceId: 'default',
      writePrecondition: { mode: 'create_only' },
    });
    expect(initial.status).toBe('created');
    const before = await snapshot(observer, slug);

    await expect(importFromContent(failingEngine, slug, markdown('failed', 'rollback-failed'), {
      noEmbed: true,
      sourceId: 'default',
      writePrecondition: { mode: 'compare_and_swap', expected_revision: 1 },
    })).rejects.toThrow('injected projection failure');

    expect(await snapshot(observer, slug)).toEqual(before);
  }, 30_000);
});
