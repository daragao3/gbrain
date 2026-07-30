/**
 * E2E synthesize inline-subagent drain — PGLite, no API key required.
 *
 * Kept in a dedicated file because every test initializes an isolated PGLite
 * engine. Combining these cases with the broader synthesize suite can exceed
 * the per-file E2E watchdog on slower hosts even when every case passes.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { __testing as synthTesting } from '../../src/core/cycle/synthesize.ts';

interface TestRig {
  engine: PGLiteEngine;
  cleanup: () => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  const engine = new PGLiteEngine();
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-inline-brain-'));
  try {
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  } catch (error) {
    try { await engine.disconnect(); } catch { /* best-effort */ }
    try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }
  return {
    engine,
    cleanup: async () => {
      try { await engine.disconnect(); } catch { /* best-effort */ }
      try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

describe('E2E synthesize — PGLite inline subagent drain (takeover of #2699)', () => {
  test('drains private subagent queue inline so the parent can observe completion', async () => {
    const rig = await setupRig();
    try {
      const { MinionQueue } = await import('../../src/core/minions/queue.ts');
      const queue = new MinionQueue(rig.engine);
      const queueName = `dream-inline-test-${Date.now()}`;
      const child = await queue.add(
        'subagent',
        { prompt: 'test', model: 'anthropic:claude-sonnet-4-6', max_turns: 1 },
        { queue: queueName, max_attempts: 1 },
        { allowProtectedSubmit: true },
      );

      let ticks = 0;
      await synthTesting.runPgliteSubagentsInline(
        rig.engine,
        queue,
        queueName,
        async () => { ticks++; },
        async (ctx) => {
          await ctx.log('inline child ran');
          await ctx.updateProgress({ step: 'done' });
          return { ok: true };
        },
      );
      expect(ticks).toBe(0);

      const final = await queue.getJob(child.id);
      expect(final?.status).toBe('completed');
      expect(final?.result).toEqual({ ok: true });
      expect(final?.progress).toEqual({ step: 'done' });

      const waiting = await rig.engine.executeRaw<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM minion_jobs WHERE queue = $1 AND status = 'waiting'`,
        [queueName],
      );
      expect(waiting[0]?.count).toBe('0');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('terminally marks failed inline children so synth parent will not hang', async () => {
    const rig = await setupRig();
    try {
      const { MinionQueue } = await import('../../src/core/minions/queue.ts');
      const queue = new MinionQueue(rig.engine);
      const queueName = `dream-inline-test-fail-${Date.now()}`;
      const child = await queue.add(
        'subagent',
        { prompt: 'test', model: 'anthropic:claude-sonnet-4-6', max_turns: 1 },
        { queue: queueName, max_attempts: 1 },
        { allowProtectedSubmit: true },
      );

      await synthTesting.runPgliteSubagentsInline(
        rig.engine,
        queue,
        queueName,
        undefined,
        async () => {
          throw new Error('synthetic child failure');
        },
      );

      const final = await queue.getJob(child.id);
      expect(final?.status).toBe('dead');
      expect(final?.error_text).toContain('synthetic child failure');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('enforces per-job timeout_ms inline: aborts the child and dead-letters it', async () => {
    const rig = await setupRig();
    try {
      const { MinionQueue } = await import('../../src/core/minions/queue.ts');
      const queue = new MinionQueue(rig.engine);
      const queueName = `dream-inline-test-timeout-${Date.now()}`;
      const child = await queue.add(
        'subagent',
        { prompt: 'test', model: 'anthropic:claude-sonnet-4-6', max_turns: 1 },
        { queue: queueName, max_attempts: 3, timeout_ms: 100 },
        { allowProtectedSubmit: true },
      );

      await synthTesting.runPgliteSubagentsInline(
        rig.engine,
        queue,
        queueName,
        undefined,
        async (ctx) => {
          await new Promise((_, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      );

      const final = await queue.getJob(child.id);
      expect(final?.status).toBe('dead');
      expect(final?.error_text).toBe('timeout exceeded');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});
