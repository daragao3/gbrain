import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const page = {
  type: 'note',
  title: 'candidate',
  compiled_truth: 'body:candidate',
  timeline: '',
  frontmatter: {},
};

function makePostgresEngineWithEmptyCreateDiagnostic(): {
  engine: PostgresEngine;
  queryCount: () => number;
} {
  let calls = 0;
  const sql = ((..._args: unknown[]) => {
    calls++;
    return Promise.resolve([]);
  }) as unknown as {
    (...args: unknown[]): Promise<unknown[]>;
    json(value: unknown): unknown;
  };
  sql.json = (value: unknown) => value;

  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = sql;
  (engine as unknown as { _connectionStyle: string })._connectionStyle = 'instance';
  return { engine, queryCount: () => calls };
}

function makePgliteEngineWithEmptyCreateDiagnostic(): {
  engine: PGLiteEngine;
  queryCount: () => number;
} {
  let calls = 0;
  const engine = Object.create(PGLiteEngine.prototype) as PGLiteEngine;
  (engine as unknown as { _db: unknown })._db = {
    query: async () => {
      calls++;
      return { rows: [] };
    },
  };
  return { engine, queryCount: () => calls };
}

describe('createPageOnly empty conflict diagnostics', () => {
  test('Postgres returns already_exists without retrying when the diagnostic row disappeared', async () => {
    const { engine, queryCount } = makePostgresEngineWithEmptyCreateDiagnostic();

    const result = await engine.createPageOnly('notes/hard-delete-race', page, { sourceId: 'default' });

    expect(result).toEqual({
      status: 'conflict',
      slug: 'notes/hard-delete-race',
      reason: 'already_exists',
    });
    expect(queryCount()).toBe(2);
  });

  test('PGLite returns already_exists without retrying when the diagnostic row disappeared', async () => {
    const { engine, queryCount } = makePgliteEngineWithEmptyCreateDiagnostic();

    const result = await engine.createPageOnly('notes/hard-delete-race', page, { sourceId: 'default' });

    expect(result).toEqual({
      status: 'conflict',
      slug: 'notes/hard-delete-race',
      reason: 'already_exists',
    });
    expect(queryCount()).toBe(2);
  });
});
