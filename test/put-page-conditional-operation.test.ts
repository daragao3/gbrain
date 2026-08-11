import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const conditionalOp = operations.find(o => o.name === 'put_page_conditional');
if (!conditionalOp) throw new Error('put_page_conditional missing');

const VALID = '---\ntype: note\ntitle: Validation\n---\n\nA substantive validation body.';
const V1 = '---\ntype: note\ntitle: Typed V1\n---\n\nFirst version body.';
const V2 = '---\ntype: note\ntitle: Typed V2\n---\n\nSecond version body.';
const MALFORMED = '---\ntitle: Broken: unquoted\ntype: note\n---\n\nBody.';

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
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
}, 120_000);

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

describe('put_page_conditional operation', () => {
  test.each([
    [{ mode: 'create_only', expected_revision: 1 }, 'create_only rejects expected_revision'],
    [{ mode: 'compare_and_swap' }, 'compare_and_swap requires expected_revision'],
    [{ mode: 'compare_and_swap', expected_revision: 0 }, 'positive safe integer'],
    [{ mode: 'compare_and_swap', expected_revision: Number.MAX_SAFE_INTEGER + 1 }, 'positive safe integer'],
  ])('validates mode/revision coupling: %s', async (params, message) => {
    await expect(
      conditionalOp.handler(makeCtx(), { slug: 'notes/validation', content: VALID, ...params }),
    ).rejects.toMatchObject({ name: 'OperationError', code: 'invalid_params' });
    await expect(
      conditionalOp.handler(makeCtx(), { slug: 'notes/validation', content: VALID, ...params }),
    ).rejects.toThrow(message);
  });

  test('rejects an unknown mode', async () => {
    await expect(
      conditionalOp.handler(makeCtx(), { slug: 'notes/validation', content: VALID, mode: 'overwrite' }),
    ).rejects.toMatchObject({ name: 'OperationError', code: 'invalid_params' });
  });

  test('returns create conflict as a normal typed value', async () => {
    const created = await conditionalOp.handler(makeCtx(), {
      slug: 'notes/typed', content: V1, mode: 'create_only',
    });
    const conflict = await conditionalOp.handler(makeCtx(), {
      slug: 'notes/typed', content: V2, mode: 'create_only',
    });
    expect(created).toMatchObject({ status: 'created' });
    expect(created).not.toMatchObject({ chronicle_backstop: { skipped: 'not_imported' } });
    expect(conflict).toEqual({
      status: 'conflict', slug: 'notes/typed', reason: 'already_exists', current_revision: 1,
    });
    expect((await engine.getPage('notes/typed', { sourceId: 'default' }))?.title).toBe('Typed V1');
  });

  test('compare_and_swap updates at the expected revision', async () => {
    await conditionalOp.handler(makeCtx(), {
      slug: 'notes/cas', content: V1, mode: 'create_only',
    });
    const updated = await conditionalOp.handler(makeCtx(), {
      slug: 'notes/cas', content: V2, mode: 'compare_and_swap', expected_revision: 1,
    });
    expect(updated).toMatchObject({ status: 'updated', slug: 'notes/cas', revision: 2 });
    expect((await engine.getPage('notes/cas', { sourceId: 'default' }))?.title).toBe('Typed V2');
  });

  test('unchanged is a typed value with no success-hook fields', async () => {
    await conditionalOp.handler(makeCtx(), {
      slug: 'notes/unchanged', content: V1, mode: 'create_only',
    });
    const unchanged = await conditionalOp.handler(makeCtx(), {
      slug: 'notes/unchanged', content: V1, mode: 'compare_and_swap', expected_revision: 1,
    });
    expect(unchanged).toEqual({ status: 'unchanged', slug: 'notes/unchanged', revision: 1, chunks: 0 });
    for (const field of [
      'write_through', 'facts_backstop', 'chronicle_backstop', 'writer_lint',
      'auto_links', 'auto_timeline',
    ]) {
      expect(unchanged).not.toHaveProperty(field);
    }
  });

  test('oversized skipped write has no success-hook fields', async () => {
    const slug = 'notes/oversized-skipped';
    const result = await conditionalOp.handler(makeCtx(), {
      slug,
      content: 'x'.repeat(5_000_001),
      mode: 'create_only',
    });

    expect(result).toMatchObject({ status: 'skipped', slug, chunks: 0 });
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    for (const field of [
      'write_through', 'facts_backstop', 'chronicle_backstop', 'writer_lint',
      'auto_links', 'auto_timeline',
    ]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  test('malformed frontmatter returns the legacy explicit refusal shape', async () => {
    const result = await conditionalOp.handler(makeCtx(), {
      slug: 'notes/malformed', content: MALFORMED, mode: 'create_only',
    });
    expect(result).toMatchObject({
      slug: 'notes/malformed',
      status: 'error',
      chunks: 0,
      frontmatter: { error: 'unparseable', page_unchanged: true },
    });
    expect(await engine.getPage('notes/malformed', { sourceId: 'default' })).toBeNull();
  });

  test('post-write lint reads the exact write source in a federated context', async () => {
    const slug = 'notes/source-scoped-lint';
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other'), ('team-x', 'team-x')");
    await engine.setConfig('writer.lint_on_put_page', 'true');

    await conditionalOp.handler(makeCtx({ sourceId: 'other' }), {
      slug,
      content: '---\ntype: note\ntitle: Other Source\n---\n\nA normal page in the other source.',
      mode: 'create_only',
    });
    const teamResult = await conditionalOp.handler(makeCtx({
      sourceId: 'team-x',
      remote: true,
      auth: {
        token: 'test-token',
        clientId: 'test-client',
        scopes: ['read', 'write'],
        sourceId: 'team-x',
        allowedSources: ['other', 'team-x'],
      },
    }), {
      slug,
      content: '---\ntype: note\ntitle: Team Source\nvalidate: false\n---\n\nThis source opts out of lint.',
      mode: 'create_only',
    });

    expect(teamResult).toMatchObject({
      status: 'created',
      writer_lint: { skipped: 'validate_false_frontmatter' },
    });
  });

  test('create conflicts are scoped to the caller source', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('team-x', 'team-x')");
    const defaultCreated = await conditionalOp.handler(makeCtx({ sourceId: 'default' }), {
      slug: 'notes/scoped', content: V1, mode: 'create_only',
    });
    const teamCreated = await conditionalOp.handler(makeCtx({ sourceId: 'team-x' }), {
      slug: 'notes/scoped', content: V2, mode: 'create_only',
    });
    expect(defaultCreated).toMatchObject({ status: 'created' });
    expect(teamCreated).toMatchObject({ status: 'created' });
    expect((await engine.getPage('notes/scoped', { sourceId: 'default' }))?.title).toBe('Typed V1');
    expect((await engine.getPage('notes/scoped', { sourceId: 'team-x' }))?.title).toBe('Typed V2');
  });
});
