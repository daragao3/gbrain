/**
 * Tests for the `gbrain config set/unset link_resolution.entity_dirs`
 * preflight.
 *
 * Removing a prefix from entity_dirs makes every reference under it
 * unextractable, and runAutoLink hard-deletes the edges those references back
 * on the next local put_page. `links` has no tombstone column. The config
 * change reads like "we index fewer dirs", so a warning is not enough — the
 * preflight refuses and requires an explicit `--yes`.
 *
 * Mirrors the existing `search_embedding_column` coverage gate in the same
 * command. Hermetic PGLite; `runConfig` is driven directly with a stubbed
 * `process.exit`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runConfig } from '../src/commands/config.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

class ExitCalled extends Error {
  constructor(public code: number) { super(`process.exit(${code})`); }
}

const realExit = process.exit;
const realError = console.error;
const realLog = console.log;
let stderr: string[] = [];
let stdout: string[] = [];

beforeEach(async () => {
  await resetPgliteState(engine);
  stderr = [];
  stdout = [];
  console.error = (...a: unknown[]) => { stderr.push(a.join(' ')); };
  console.log = (...a: unknown[]) => { stdout.push(a.join(' ')); };
  (process as { exit: unknown }).exit = (code?: number) => { throw new ExitCalled(code ?? 0); };
});

afterEach(() => {
  (process as { exit: unknown }).exit = realExit;
  console.error = realError;
  console.log = realLog;
});

/** Runs runConfig, returning the exit code if it exited, else null. */
async function run(args: string[]): Promise<number | null> {
  try {
    await runConfig(engine, args);
    return null;
  } catch (e) {
    if (e instanceof ExitCalled) return e.code;
    throw e;
  }
}

async function seedPage(slug: string, compiledTruth = ''): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at)
     VALUES ($1, 'default', 'concept', $1, $2, '', '{}'::jsonb, $1, now(), now())
     RETURNING id`,
    [slug, compiledTruth],
  );
  return rows[0].id;
}

/** A page whose markdown edges sit under sessions/ and systems/. */
async function seedTheHazard(): Promise<void> {
  const from = await seedPage(
    'systems/write-semantics',
    'See [[sessions/cutover]] and [[systems/widget-service]].',
  );
  for (const t of ['sessions/cutover', 'systems/widget-service']) {
    const to = await seedPage(t);
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source, created_at)
       VALUES ($1, $2, 'mentions', 'markdown', now())`,
      [from, to],
    );
  }
}

describe('config set link_resolution.entity_dirs preflight', () => {
  test('removing a prefix that backs live edges is refused', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems');

    const code = await run(['set', 'link_resolution.entity_dirs', 'sessions']);

    expect(code).toBe(1);
    const out = stderr.join('\n');
    expect(out).toContain('systems');
    expect(out).toContain('--yes');
    // The refusal must not have persisted the narrower value.
    expect(await engine.getConfig('link_resolution.entity_dirs')).toBe('sessions,systems');
  });

  test('the refusal names the at-risk edge so it can be verified', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems');

    await run(['set', 'link_resolution.entity_dirs', 'sessions']);

    const out = stderr.join('\n');
    expect(out).toContain('systems/write-semantics');
    expect(out).toContain('systems/widget-service');
  });

  test('--yes proceeds and persists', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems');

    const code = await run(['set', 'link_resolution.entity_dirs', 'sessions', '--yes']);

    expect(code).toBeNull();
    expect(await engine.getConfig('link_resolution.entity_dirs')).toBe('sessions');
  });

  test('removing a prefix that backs NOTHING proceeds silently', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems,runbooks');

    // `runbooks` is declared but no edge depends on it — no data to lose.
    const code = await run(['set', 'link_resolution.entity_dirs', 'sessions,systems']);

    expect(code).toBeNull();
    expect(await engine.getConfig('link_resolution.entity_dirs')).toBe('sessions,systems');
  });

  test('ADDING a prefix is never refused', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems');

    const code = await run(['set', 'link_resolution.entity_dirs', 'sessions,systems,infra']);

    expect(code).toBeNull();
    expect(await engine.getConfig('link_resolution.entity_dirs')).toBe('sessions,systems,infra');
  });

  test('an unrelated config key is unaffected by the gate', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems');

    const code = await run(['set', 'link_resolution.global_basename', 'true']);

    expect(code).toBeNull();
  });

  test('unset is gated too — it removes every declared prefix at once', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems');

    const code = await run(['unset', 'link_resolution.entity_dirs']);

    expect(code).toBe(1);
    expect(await engine.getConfig('link_resolution.entity_dirs')).toBe('sessions,systems');
  });

  test('unset --yes proceeds', async () => {
    await seedTheHazard();
    await engine.setConfig('link_resolution.entity_dirs', 'sessions,systems');

    const code = await run(['unset', 'link_resolution.entity_dirs', '--yes']);

    expect(code).toBeNull();
    expect(await engine.getConfig('link_resolution.entity_dirs')).toBeNull();
  });
});
