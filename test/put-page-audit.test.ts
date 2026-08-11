/**
 * Tests for src/core/audit/put-page-audit.ts.
 *
 * The stream exists because put_page's post-processing results (auto_links,
 * auto_timeline, chronicle_backstop, writer_lint) were reported ONLY in the
 * response body. Over the HTTP MCP transport the SSE headers are flushed
 * BEFORE the tool handler runs, so a server dying mid-request returns HTTP 200
 * with a zero-length body while the write has already committed — the write
 * survives, the report of what it did does not. `auto_timeline.created` is the
 * field that matters (nonzero on an edit means duplicate timeline rows were
 * minted) and it was unrecoverable after the fact without a pre-write psql
 * snapshot.
 *
 * Writes go to a temp GBRAIN_AUDIT_DIR so the suite never touches
 * ~/.gbrain/audit.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';

let auditDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-putpage-audit-'));
});

afterEach(() => {
  rmSync(auditDir, { recursive: true, force: true });
});

/**
 * Run `fn` with GBRAIN_AUDIT_DIR pointed at this test's temp dir. Goes through
 * `withEnv` so the process-global env is restored even on throw — a bare
 * assignment here leaks the temp path into every other file sharing the shard
 * process (and trips scripts/check-test-isolation.sh's R1).
 */
function inAuditDir<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_AUDIT_DIR: auditDir }, fn);
}

/** Read every JSONL row the writer produced, in file order. */
function readRows(): Array<Record<string, unknown>> {
  const files = readdirSync(auditDir).filter(f => f.endsWith('.jsonl'));
  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of readFileSync(join(auditDir, f), 'utf-8').split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  return rows;
}

describe('extractTimelineCreated', () => {
  test('lifts a numeric created out of the success variant', async () => {
    const { extractTimelineCreated } = await import('../src/core/audit/put-page-audit.ts');
    expect(extractTimelineCreated({ created: 12 })).toBe(12);
    expect(extractTimelineCreated({ created: 0 })).toBe(0);
  });

  test('returns undefined for the error / skipped / absent variants', async () => {
    const { extractTimelineCreated } = await import('../src/core/audit/put-page-audit.ts');
    expect(extractTimelineCreated({ error: 'boom' })).toBeUndefined();
    expect(extractTimelineCreated({ skipped: 'remote' })).toBeUndefined();
    expect(extractTimelineCreated(undefined)).toBeUndefined();
    expect(extractTimelineCreated(null)).toBeUndefined();
    expect(extractTimelineCreated('nope')).toBeUndefined();
  });
});

describe('logPutPagePostProcessing', () => {
  test('records auto_timeline.created as a flat, greppable field', async () => {
    const { logPutPagePostProcessing } = await import('../src/core/audit/put-page-audit.ts');
    await inAuditDir(() => {
      logPutPagePostProcessing('projects/agent-fork', 'default', 'imported', true, {
        auto_timeline: { created: 12 },
        auto_links: { created: 3, removed: 1, errors: 0, unresolved: [] },
      });

      const rows = readRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.slug).toBe('projects/agent-fork');
      expect(rows[0]!.source_id).toBe('default');
      expect(rows[0]!.status).toBe('imported');
      expect(rows[0]!.remote).toBe(true);
      expect(rows[0]!.timeline_created).toBe(12);
      // verbatim payload preserved alongside the lifted field
      expect(rows[0]!.auto_timeline).toEqual({ created: 12 });
      expect(rows[0]!.auto_links).toEqual({ created: 3, removed: 1, errors: 0, unresolved: [] });
      expect(typeof rows[0]!.ts).toBe('string');
    });
  });

  test('records the quiet all-zero case — "created 0" is the reassurance', async () => {
    const { logPutPagePostProcessing } = await import('../src/core/audit/put-page-audit.ts');
    await inAuditDir(() => {
      logPutPagePostProcessing('projects/agent-fork', 'default', 'skipped', true, {
        auto_timeline: { created: 0 },
      });

      const rows = readRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.timeline_created).toBe(0);
    });
  });

  test('captures the duplicate-minting shape: status=skipped with created>0', async () => {
    const { logPutPagePostProcessing } = await import('../src/core/audit/put-page-audit.ts');
    await inAuditDir(() => {
      logPutPagePostProcessing('projects/agent-fork', 'default', 'skipped', true, {
        auto_timeline: { created: 12 },
      });

      const rows = readRows();
      expect(rows[0]!.status).toBe('skipped');
      expect(rows[0]!.timeline_created).toBe(12);
    });
  });

  test('omits timeline_created but keeps the verbatim error variant', async () => {
    const { logPutPagePostProcessing } = await import('../src/core/audit/put-page-audit.ts');
    await inAuditDir(() => {
      logPutPagePostProcessing('projects/agent-fork', 'default', 'imported', true, {
        auto_timeline: { error: 'connection lost' },
      });

      const rows = readRows();
      expect(rows[0]!).not.toHaveProperty('timeline_created');
      expect(rows[0]!.auto_timeline).toEqual({ error: 'connection lost' });
    });
  });

  test('writes nothing when no hook ran at all', async () => {
    const { logPutPagePostProcessing } = await import('../src/core/audit/put-page-audit.ts');
    await inAuditDir(() => {
      logPutPagePostProcessing('projects/agent-fork', 'default', 'imported', false, {});
      expect(readRows()).toHaveLength(0);
    });
  });

  test('never throws — an audit failure must not fail the write', async () => {
    const { logPutPagePostProcessing } = await import('../src/core/audit/put-page-audit.ts');
    // Point the writer at a path that cannot be created.
    const badDir = join(auditDir, 'a-file-not-a-dir', '\0invalid');
    await withEnv({ GBRAIN_AUDIT_DIR: badDir }, () => {
      expect(() =>
        logPutPagePostProcessing('projects/agent-fork', 'default', 'imported', true, {
          auto_timeline: { created: 1 },
        }),
      ).not.toThrow();
    });
  });
});

describe('findRecentPutPageEventsForSlug', () => {
  test('returns only the asked-for slug, newest first', async () => {
    const { logPutPagePostProcessing, findRecentPutPageEventsForSlug } =
      await import('../src/core/audit/put-page-audit.ts');

    await inAuditDir(() => {
      logPutPagePostProcessing('projects/agent-fork', 'default', 'imported', true, {
        auto_timeline: { created: 1 },
      });
      logPutPagePostProcessing('systems/other', 'default', 'imported', true, {
        auto_timeline: { created: 99 },
      });
      logPutPagePostProcessing('projects/agent-fork', 'default', 'imported', true, {
        auto_timeline: { created: 2 },
      });

      const found = findRecentPutPageEventsForSlug('projects/agent-fork');
      expect(found).toHaveLength(2);
      expect(found.every(e => e.slug === 'projects/agent-fork')).toBe(true);
      // newest first — ts is non-decreasing in write order, so the later row leads
      expect(found[0]!.ts >= found[1]!.ts).toBe(true);
    });
  });
});
