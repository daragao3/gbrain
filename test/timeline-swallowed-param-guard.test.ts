/**
 * add_timeline_entry: reject a tool-call argument swallowed into a field value.
 *
 * The corrupt shape is an UNCLOSED parameter tag at end-of-string, e.g. a detail
 * ending "...text.</detail>\n<parameter name=\"source\">loops:my-claim" while the
 * `source` argument itself arrived empty. Before this guard the write succeeded and
 * returned {status:'ok'} - identical to a silent duplicate no-op - so nothing told
 * the caller. Measured 2026-09-04 on a production brain: 75 rows across 36 pages
 * between 2026-04-25 and 2026-09-03, 72 swallowing `source`; repair needed direct
 * SQL because there is no timeline update/delete on the MCP surface.
 *
 * BOTH DIRECTIONS matter here. The detector must fire on the corrupt shape AND stay
 * silent on prose that merely QUOTES the markup - the timeline entries documenting
 * this very bug contain the tag as quoted text, and rejecting those would make the
 * bug impossible to write about.
 *
 * Uses dryRun ctxs: the check runs BEFORE the dry-run short-circuit, so no engine is
 * needed (same pattern as test/timeline-entry-subagent-fence.test.ts).
 */

import { describe, test, expect } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const add_timeline_entry = operations.find(o => o.name === 'add_timeline_entry') as Operation;
if (!add_timeline_entry) throw new Error('add_timeline_entry op missing');

const BASE = { slug: 'systems/example', date: '2026-09-04', summary: 'ok summary' };

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const engine = {} as BrainEngine; // dry_run short-circuits before touching the engine
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

describe('add_timeline_entry swallowed-parameter guard', () => {
  describe('rejects the corrupt shape', () => {
    test('detail ending in an unclosed source tag is rejected', async () => {
      const detail = 'Real content that is fine.</detail>\n<parameter name="source">loops:my-claim';
      const p = add_timeline_entry.handler(makeCtx(), { ...BASE, detail, source: '' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/unclosed <parameter name="source">/);
    });

    test('the error names the field, the parameter, and the recovered value', async () => {
      const detail = 'Body.</detail>\n<parameter name="source">loops:abc-123';
      try {
        await add_timeline_entry.handler(makeCtx(), { ...BASE, detail });
        throw new Error('expected a rejection');
      } catch (e) {
        const err = e as OperationError;
        expect(err.code).toBe('invalid_params');
        expect(err.message).toContain("'detail'");
        expect(err.message).toContain('source');
        expect(err.suggestion).toContain('loops:abc-123');
        expect(err.suggestion).toContain('Nothing was written.');
      }
    });

    test('summary is checked too (observed corrupt in production)', async () => {
      const summary = 'CORRECTION: something\n<parameter name="source">session-x';
      const p = add_timeline_entry.handler(makeCtx(), { ...BASE, summary });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/'summary'/);
    });

    test('source itself is checked', async () => {
      const source = 'session-a\n<parameter name="detail">leaked body';
      const p = add_timeline_entry.handler(makeCtx(), { ...BASE, source });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/'source'/);
    });

    test('fires without a preceding </detail> marker', async () => {
      const detail = 'Body text\n<parameter name="source">only-the-tag';
      const p = add_timeline_entry.handler(makeCtx(), { ...BASE, detail });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test('rejection happens on a DRY RUN too, not just a real write', async () => {
      const detail = 'Body.</detail>\n<parameter name="source">x';
      const p = add_timeline_entry.handler(makeCtx({ dryRun: true }), { ...BASE, detail });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });
  });

  describe('does NOT reject legitimate prose (the false-positive half)', () => {
    test('prose quoting the markup with a CLOSING tag is accepted', async () => {
      const detail = 'The row ends with <parameter name="source">value</parameter> which is the bug.';
      const result = await add_timeline_entry.handler(makeCtx(), { ...BASE, detail });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('prose mentioning the tag followed by more markup is accepted', async () => {
      const detail = 'It emits <parameter name="source"> and then <b>more</b> text afterwards.';
      const result = await add_timeline_entry.handler(makeCtx(), { ...BASE, detail });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('a bare </detail> in quoted prose is accepted (no parameter tag)', async () => {
      const detail = 'Its detail ends with the stray literal text "</detail>" and an empty source.';
      const result = await add_timeline_entry.handler(makeCtx(), { ...BASE, detail });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('regression: an ordinary entry with no markup is unaffected', async () => {
      const result = await add_timeline_entry.handler(makeCtx(), {
        ...BASE, detail: 'A perfectly ordinary body.', source: 'session-2026-09-04-example',
      });
      expect(result).toMatchObject({ dry_run: true, action: 'add_timeline_entry' });
    });

    test('omitted detail/source (undefined) is unaffected', async () => {
      const result = await add_timeline_entry.handler(makeCtx(), { ...BASE });
      expect(result).toMatchObject({ dry_run: true });
    });
  });
});
