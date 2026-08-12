import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { getContentFlag } from '../src/core/quarantine.ts';
import { isEmbedSkipped } from '../src/core/embed-skip.ts';
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
});

function makeCtx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'put-page-sanity-home-'));
  const audit = mkdtempSync(join(tmpdir(), 'put-page-sanity-audit-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(audit, { recursive: true, force: true });
  }
}

describe('legacy put_page content-sanity response and hooks', () => {
  test('soft oversized write returns legacy success and runs successful-write hooks', async () => {
    await withIsolatedHome(async () => {
      const slug = 'notes/legacy-soft-oversized';
      const content = '---\ntype: note\ntitle: Legacy Soft Oversized\n---\n\n' + 'a'.repeat(600_000);
      const result = await putPageOp.handler(makeCtx(), { slug, content });

      expect(result).toMatchObject({
        slug,
        status: 'created_or_updated',
        chunks: 0,
        facts_backstop: { queued: true },
        chronicle_backstop: { skipped: 'kind:note' },
        writer_lint: { skipped: 'flag_disabled' },
        write_through: { written: false, skipped: 'no_repo_configured' },
      });
      expect(result).toHaveProperty('auto_links');
      expect(result).toHaveProperty('auto_timeline');

      const page = await engine.getPage(slug, { sourceId: 'default' });
      expect(page).not.toBeNull();
      expect(isEmbedSkipped(page!.frontmatter)).toBe(true);
      expect(getContentFlag(page!.frontmatter)?.reason).toBe('oversized');
      expect(await engine.getChunks(slug, { sourceId: 'default' })).toHaveLength(0);
    });
  });

  test('hard oversized legacy skip preserves the historical hook path', async () => {
    await withIsolatedHome(async () => {
      const slug = 'notes/legacy-hard-oversized';
      const result = await putPageOp.handler(makeCtx(), {
        slug,
        content: 'x'.repeat(5_000_001),
      });

      expect(result).toMatchObject({
        slug,
        status: 'skipped',
        chunks: 0,
        facts_backstop: { skipped: 'backstop_error' },
        chronicle_backstop: { skipped: 'not_imported' },
        writer_lint: { skipped: 'flag_disabled' },
        write_through: { written: false, skipped: 'no_repo_configured' },
      });
      expect(result).not.toHaveProperty('auto_links');
      expect(result).not.toHaveProperty('auto_timeline');
      expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    });
  });
});
