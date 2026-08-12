import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { computeSchemaEventPath } from '../src/core/schema-events.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/index.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const putPageOp = operations.find(o => o.name === 'put_page');
if (!putPageOp) throw new Error('put_page missing');

let engine: PGLiteEngine;

beforeAll(async () => {
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
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
});

function makeCtx(remote: boolean): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote,
    sourceId: 'default',
  };
}

async function withIsolatedAudit<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'put-page-unknown-home-'));
  const audit = mkdtempSync(join(tmpdir(), 'put-page-unknown-audit-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit, GBRAIN_SCHEMA_PACK: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(audit, { recursive: true, force: true });
  }
}

function setStderrTty(value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  };
}

const UNKNOWN_CONTENT = '---\ntype: custom-unknown-type\ntitle: Unknown Type\n---\n\nA substantive legacy put page body.';

describe('legacy put_page unknown-type audit and prompt', () => {
  test('trusted TTY write audits the unknown type and emits the local prompt', async () => {
    await withIsolatedAudit(async () => {
      const restoreTty = setStderrTty(true);
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await putPageOp.handler(makeCtx(false), {
          slug: 'notes/legacy-unknown-local',
          content: UNKNOWN_CONTENT,
        });
        expect(result).toMatchObject({ status: 'created_or_updated' });

        const records = readFileSync(computeSchemaEventPath(), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        expect(records).toContainEqual(expect.objectContaining({
          verb: 'put_page:unknown_type',
          outcome: 'success',
          flags: expect.arrayContaining(['type=custom-unknown-type', 'slug=notes/legacy-unknown-local']),
        }));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("put_page wrote type=`custom-unknown-type`"));
      } finally {
        errorSpy.mockRestore();
        restoreTty();
      }
    });
  });

  test('remote TTY write audits but never emits the trusted local prompt', async () => {
    await withIsolatedAudit(async () => {
      const restoreTty = setStderrTty(true);
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await putPageOp.handler(makeCtx(true), {
          slug: 'notes/legacy-unknown-remote',
          content: UNKNOWN_CONTENT,
        });
        expect(result).toMatchObject({ status: 'created_or_updated' });
        const records = readFileSync(computeSchemaEventPath(), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        expect(records.some(record => record.verb === 'put_page:unknown_type')).toBe(true);
        expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('put_page wrote type='));
      } finally {
        errorSpy.mockRestore();
        restoreTty();
      }
    });
  });
});
