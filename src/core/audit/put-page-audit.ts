/**
 * put_page post-processing audit JSONL.
 *
 * Writes events at `~/.gbrain/audit/put-page-YYYY-Www.jsonl` (ISO-week
 * rotation), built on the shared `audit-writer.ts` primitive and honoring the
 * `GBRAIN_AUDIT_DIR` env override — same conventions as
 * `content-sanity-audit.ts`.
 *
 * WHY THIS STREAM EXISTS
 *
 * put_page's post-write hooks (auto-link reconciliation, timeline extraction,
 * chronicle backstop, writer lint) report their results in exactly ONE place:
 * the operation's return value, which reaches the caller only as the body of
 * the HTTP/stdio response. Nothing persisted them.
 *
 * That made the reporting only as durable as the response. Over the HTTP MCP
 * transport the SSE headers are flushed BEFORE the tool handler runs, so a
 * server that dies mid-request hands the client HTTP 200 with a zero-length
 * body while the write itself has already committed. The write is fine; the
 * report of what the write DID is gone, irrecoverably.
 *
 * `auto_timeline.created` is the field that actually matters here. A nonzero
 * value on a page that was only edited (not extended) means the write minted
 * duplicate timeline rows — the signal operators are supposed to check on
 * EVERY put. Recovering it after a lost response previously required a direct
 * `SELECT count(*), max(id) FROM timeline_entries WHERE page_id=...` snapshot
 * taken BEFORE the write, which is both psql-only and useless after the fact.
 *
 * A row here makes the answer recoverable from any caller, after the fact,
 * with no database access.
 *
 * Best-effort: the audit-writer primitive stderr-warns on failure and never
 * throws. The write path continues regardless — an audit problem must never
 * turn a successful put_page into a failed one.
 */

import { createAuditWriter, computeIsoWeekFilename } from './audit-writer.ts';

/**
 * Post-processing summary as reported back to the caller. Every field is
 * optional because each hook is independently feature-flagged, skipped for
 * remote callers, or absent on a no-op write — the shape mirrors the
 * conditional spread at the end of `executePutPage`.
 *
 * Values are recorded verbatim (including `{ error }` and `{ skipped }`
 * variants) so the row reproduces what the caller would have seen in the
 * response body, not a lossy re-interpretation of it.
 */
export interface PutPagePostProcessing {
  auto_links?: unknown;
  auto_timeline?: unknown;
  writer_lint?: unknown;
  facts_backstop?: unknown;
  chronicle_backstop?: unknown;
  write_through?: unknown;
}

export interface PutPageAuditEvent extends PutPagePostProcessing {
  ts: string;
  /** Page slug that was written. */
  slug: string;
  /** Source ID the write was scoped to. */
  source_id: string;
  /** Whether the page actually changed: importFromContent's status
   *  ('created_or_updated', 'skipped', ...). A 'skipped' row with a nonzero
   *  auto_timeline.created is the duplicate-minting shape worth alerting on. */
  status: string;
  /** True when the call came in over a remote transport (MCP/HTTP) — the
   *  callers whose response can be lost in flight. */
  remote: boolean;
  /** Number of timeline rows the write created, lifted out of `auto_timeline`
   *  so the field operators care about is greppable without parsing a nested
   *  union. Omitted when the hook errored, was skipped, or did not run. */
  timeline_created?: number;
}

/** Filename matches the audit-writer's ISO-week convention. */
export function computePutPageAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('put-page', now);
}

const writer = createAuditWriter<PutPageAuditEvent>({
  featureName: 'put-page',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'put-page audit ',
  errorTrailer: '; write continues',
});

/**
 * Lift `auto_timeline.created` out of the union so the audit row carries a
 * flat, greppable number. Returns undefined for the `{ error }` / `{ skipped }`
 * variants and for a hook that never ran — those cases are still fully
 * represented by the verbatim `auto_timeline` field.
 *
 * Exported for unit tests.
 */
export function extractTimelineCreated(autoTimeline: unknown): number | undefined {
  if (!autoTimeline || typeof autoTimeline !== 'object') return undefined;
  const created = (autoTimeline as { created?: unknown }).created;
  return typeof created === 'number' ? created : undefined;
}

/**
 * Append one row per put_page that ran post-processing.
 *
 * Rows are written unconditionally when at least one hook produced a result —
 * including the all-zero case. "auto_timeline.created was 0" is exactly the
 * reassurance a caller who lost the response needs, so suppressing quiet rows
 * would defeat the purpose of the stream.
 */
export function logPutPagePostProcessing(
  slug: string,
  sourceId: string,
  status: string,
  remote: boolean,
  post: PutPagePostProcessing,
): void {
  // Nothing ran (every hook disabled/absent) → nothing to report.
  const ranSomething = Object.values(post).some(v => v !== undefined);
  if (!ranSomething) return;

  const timelineCreated = extractTimelineCreated(post.auto_timeline);
  writer.log({
    slug,
    source_id: sourceId,
    status,
    remote,
    ...post,
    ...(timelineCreated !== undefined ? { timeline_created: timelineCreated } : {}),
  });
}

/**
 * Read recent rows. 7-day default window; reads current + previous ISO week
 * files so a window straddling Monday-midnight stays covered.
 */
export function readRecentPutPageEvents(
  days = 7,
  now: Date = new Date(),
): PutPageAuditEvent[] {
  return writer.readRecent(days, now);
}

/**
 * Find the most recent rows for a slug, newest first. This is the recovery
 * path: a caller whose response was lost asks "what did my write to X
 * actually do?" without needing database access.
 */
export function findRecentPutPageEventsForSlug(
  slug: string,
  days = 7,
  now: Date = new Date(),
): PutPageAuditEvent[] {
  return readRecentPutPageEvents(days, now)
    .filter(ev => ev.slug === slug)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
