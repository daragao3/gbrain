/**
 * entity_dirs safety guard.
 *
 * `link_resolution.entity_dirs` reads as a recall/coverage knob — "which
 * top-level slug dirs produce typed edges". It is also load-bearing SAFETY.
 *
 * `runAutoLink` (src/core/operations.ts) is the only automatic link-deletion
 * path. It deletes every reconcilable edge whose
 * `to_slug\0link_type\0link_source` key is absent from the freshly-extracted
 * desired set, and that removal loop is NOT gated on the desired set being
 * empty. `extractPageLinks` gates its wikilink / markdown-link / bare-slug
 * passes on DIR_PATTERN = DEFAULT_ENTITY_DIRS + the operator dirs. So dropping
 * a prefix from `entity_dirs` makes every reference under it unextractable,
 * and its existing edges are hard-deleted on the next local put_page. `links`
 * has no tombstone column: the delete is unrecoverable.
 *
 * It reads like "we index fewer dirs". It acts like "we re-arm an
 * unrecoverable delete".
 *
 * This module answers one question against real brain state: which existing
 * edges would the CURRENTLY CONFIGURED entity_dirs fail to re-extract? Two
 * callers use it — the `entity_dirs_orphaned_edges` doctor check (after the
 * fact) and the `gbrain config set link_resolution.entity_dirs` preflight (at
 * the moment of removal).
 *
 * Engine parity: `executeRaw` only, plain portable SQL. No new engine method
 * and no schema change, so postgres-engine.ts and pglite-engine.ts are
 * untouched.
 */

import type { BrainEngine } from './engine.ts';
import { extractUndeclaredPrefixRefs, normalizeEntityDirs } from './link-extraction.ts';
import { startHeartbeat, type ProgressReporter } from './progress.ts';

/** One edge that the current entity_dirs can no longer re-extract. */
export interface AtRiskEdge {
  /** Page that owns the edge (and whose prose still carries the reference). */
  fromSlug: string;
  /** Edge target. */
  toSlug: string;
  /** The undeclared top-level dir — the exact string to add to entity_dirs. */
  dir: string;
}

export interface OrphanScanResult {
  /** At-risk edges, sorted by (fromSlug, toSlug) so output is stable. */
  atRisk: AtRiskEdge[];
  /** Edge count per undeclared prefix. */
  byPrefix: Record<string, number>;
  /** Distinct pages carrying at least one at-risk edge. */
  pagesAffected: number;
  /** Pages examined. */
  pagesScanned: number;
  /**
   * True when the wall-clock backstop cut the scan short. Callers MUST say so
   * — a silently-sampled safety check reads as "covered everything".
   */
  truncated: boolean;
}

export interface OrphanScanOptions {
  /** Operator-declared dirs to evaluate against (the current or proposed set). */
  entityDirs: readonly string[];
  /**
   * Restrict findings to these prefixes. The preflight passes the prefixes
   * being REMOVED so it reports only newly-orphaned edges rather than
   * everything already orphaned by some earlier config.
   */
  onlyPrefixes?: readonly string[];
  /** Bulk-scan heartbeat. Writes to stderr, per the progress contract. */
  progress?: ProgressReporter;
  /** Wall-clock backstop in ms. */
  budgetMs?: number;
  /**
   * Row cap on the page-body query. Page bodies are unbounded, so this is the
   * memory bound; hitting it sets `truncated`.
   */
  maxPages?: number;
}

const DEFAULT_BUDGET_MS = 60_000;
/**
 * Generous by design: this is a safety check, so scanning everything is the
 * default and the cap exists only to keep a pathologically large brain from
 * loading every page body at once. Sibling doctor checks sample at 1000.
 */
const DEFAULT_MAX_PAGES = 5000;

/**
 * Reconciliation classes runAutoLink is allowed to delete AND that the
 * dir-gated prose passes produce. `manual` is never touched by
 * reconciliation; `frontmatter` does not come from prose; `wikilink-resolved`
 * comes from the basename path, which is prefix-independent and therefore
 * unaffected by an entity_dirs change.
 */
const DELETABLE_LINK_SOURCE_SQL = `(l.link_source = 'markdown' OR l.link_source IS NULL)`;

/**
 * The operator-controlled prefixes present in `current` but absent from
 * `proposed`. Both sides go through `normalizeEntityDirs`, which lowercases,
 * trims, drops invalid shapes, and drops canonical `DEFAULT_ENTITY_DIRS`
 * entries — a canonical dir is not operator-controlled, so removing it from
 * the operator list changes nothing and must not be reported as a removal.
 */
export function prefixesRemovedBy(
  current: readonly string[] | undefined,
  proposed: readonly string[] | undefined,
): string[] {
  const before = normalizeEntityDirs(current);
  const after = new Set(normalizeEntityDirs(proposed));
  return before.filter((d) => !after.has(d)).sort();
}

/** The config key both surfaces of this guard are about. */
export const ENTITY_DIRS_CONFIG_KEY = 'link_resolution.entity_dirs';

/** Parse the comma-separated config value into dirs. */
export function parseEntityDirsValue(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  return normalizeEntityDirs(String(raw).split(','));
}

/**
 * Preflight for a proposed `entity_dirs` change: would it orphan edges that
 * exist right now?
 *
 * Scans only the prefixes being REMOVED, so the operator is shown the
 * consequence of THIS change rather than everything some earlier config
 * already orphaned. Returns `blocked: false` with no scan when the change adds
 * prefixes or removes ones nothing depends on.
 */
export async function assessEntityDirsRemoval(
  engine: BrainEngine,
  current: readonly string[],
  proposed: readonly string[],
  progress?: ProgressReporter,
): Promise<{ removed: string[]; scan: OrphanScanResult | null; blocked: boolean }> {
  const removed = prefixesRemovedBy(current, proposed);
  if (removed.length === 0) return { removed, scan: null, blocked: false };
  const scan = await scanOrphanedMarkdownEdges(engine, {
    // Evaluate against the PROPOSED config — that is what extraction will use.
    entityDirs: proposed,
    onlyPrefixes: removed,
    progress,
  });
  return { removed, scan, blocked: scan.atRisk.length > 0 };
}

/**
 * The refusal text, as stderr lines. Kept beside the scan so the wording and
 * the numbers cannot drift apart.
 */
export function formatEntityDirsRemovalRefusal(
  removed: readonly string[],
  scan: OrphanScanResult,
  current: readonly string[],
): string[] {
  const affectedPrefixes = Object.keys(scan.byPrefix).sort();
  const examples = scan.atRisk.slice(0, 5).map((e) => `  ${e.fromSlug} → ${e.toSlug}`);
  const more = scan.atRisk.length > 5 ? [`  … +${scan.atRisk.length - 5} more`] : [];
  return [
    `[config] Refusing: this would drop ${removed.map((d) => `'${d}'`).join(', ')} from ` +
      `${ENTITY_DIRS_CONFIG_KEY}, and ${scan.atRisk.length} existing link(s) across ` +
      `${scan.pagesAffected} page(s) still reference ${affectedPrefixes.map((d) => `${d}/`).join(', ')}.`,
    `[config] entity_dirs is not only a recall knob. A prefix it does not declare is not`,
    `[config] extractable, so the next local put_page on those pages re-extracts, misses`,
    `[config] these references, and hard-deletes the links. links has no tombstone column:`,
    `[config] the delete is unrecoverable.`,
    `[config] Links that would be lost:`,
    ...examples,
    ...more,
    ...(scan.truncated
      ? [`[config] (scan hit its time budget after ${scan.pagesScanned} page(s) — the real count may be higher)`]
      : []),
    `[config] Keep them by leaving the prefixes declared:`,
    `[config]   gbrain config set ${ENTITY_DIRS_CONFIG_KEY} '${[...current].sort().join(',')}'`,
    `[config] Or accept the loss explicitly by re-running with --yes.`,
  ];
}

/**
 * Find existing deletable edges whose prose reference sits under a prefix
 * `entityDirs` does not declare.
 *
 * The intersection against real edges is load-bearing.
 * `extractUndeclaredPrefixRefs` is deliberately permissive (wildcard prefix),
 * so on its own it reports any `[label](foo/bar)` in prose. A reference only
 * becomes a finding when a real edge backs it — nothing is at risk if there is
 * no edge to lose.
 */
export async function scanOrphanedMarkdownEdges(
  engine: BrainEngine,
  opts: OrphanScanOptions,
): Promise<OrphanScanResult> {
  const only = opts.onlyPrefixes ? new Set(normalizeEntityDirs(opts.onlyPrefixes)) : null;

  // Edges first: a page with no deletable edge can never produce a finding, so
  // this also bounds which page bodies we have to read.
  const edgeRows = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
    `SELECT fp.slug AS from_slug, tp.slug AS to_slug
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       JOIN pages tp ON tp.id = l.to_page_id
      WHERE ${DELETABLE_LINK_SOURCE_SQL}
        AND fp.deleted_at IS NULL
        AND tp.deleted_at IS NULL`,
  );

  const edgesByPage = new Map<string, Set<string>>();
  for (const r of edgeRows) {
    let set = edgesByPage.get(r.from_slug);
    if (!set) { set = new Set(); edgesByPage.set(r.from_slug, set); }
    set.add(r.to_slug);
  }

  if (edgesByPage.size === 0) {
    return { atRisk: [], byPrefix: {}, pagesAffected: 0, pagesScanned: 0, truncated: false };
  }

  // Fetch one row past the cap so a full result set can be distinguished from
  // one that happens to land exactly on the cap.
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const pageRows = await engine.executeRaw<{
    slug: string;
    compiled_truth: string | null;
    timeline: string | null;
  }>(
    `SELECT p.slug, p.compiled_truth, p.timeline
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND EXISTS (
              SELECT 1 FROM links l
               WHERE l.from_page_id = p.id AND ${DELETABLE_LINK_SOURCE_SQL}
            )
      ORDER BY p.id
      LIMIT ${maxPages + 1}`,
  );

  const atRisk: AtRiskEdge[] = [];
  const byPrefix: Record<string, number> = {};
  const affected = new Set<string>();
  let pagesScanned = 0;
  let truncated = false;

  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const hb = opts.progress
    ? startHeartbeat(opts.progress, `scanning ${pageRows.length} linked page(s) for undeclared entity_dirs prefixes…`)
    : null;
  try {
    for (const row of pageRows) {
      if (pagesScanned >= maxPages) { truncated = true; break; }
      if (Date.now() > deadline) { truncated = true; break; }
      pagesScanned++;
      const targets = edgesByPage.get(row.slug);
      if (!targets || targets.size === 0) continue;
      // Same content runAutoLink extracts from.
      const content = (row.compiled_truth ?? '') + '\n' + (row.timeline ?? '');
      for (const ref of extractUndeclaredPrefixRefs(content, opts.entityDirs)) {
        if (only && !only.has(ref.dir)) continue;
        if (!targets.has(ref.slug)) continue;
        atRisk.push({ fromSlug: row.slug, toSlug: ref.slug, dir: ref.dir });
        byPrefix[ref.dir] = (byPrefix[ref.dir] ?? 0) + 1;
        affected.add(row.slug);
      }
    }
  } finally {
    hb?.();
  }

  atRisk.sort((a, b) => a.fromSlug.localeCompare(b.fromSlug) || a.toSlug.localeCompare(b.toSlug));

  return { atRisk, byPrefix, pagesAffected: affected.size, pagesScanned, truncated };
}
