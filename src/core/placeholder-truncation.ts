/**
 * Placeholder-truncation guard (2026-08-10 KB incident).
 *
 * One agent session rewrote three pages inside 53 seconds, each time replacing
 * most of the compiled truth with a single bracketed line that ASSERTS the
 * content is unchanged while being the very edit that removed it:
 *
 *   "[Previous sections 1-3 and Open Items omitted for brevity - unchanged from prior revision]"
 *   "[Same as prior revision - unchanged]"
 *   "[Remaining sections - degraded signals, durable operating rules - unchanged]"
 *
 * Roughly 12KB of verified fact vanished; every write reported success, and a
 * reader got no signal beyond the page looking short.
 *
 * ## Why the detector is structural
 *
 * Matching the WORDING ("omitted for brevity", "unchanged from prior
 * revision") provably misses real cases — it misses the third line above. The
 * invariant that actually holds across all three is the SHAPE: a line whose
 * entire content is one bracketed span.
 *
 *     trimmed line matches /^\[.{10,}\]$/   AND   does not start with "[["
 *
 * The 10-character floor keeps short bracketed tokens out; the "[[" exclusion
 * keeps wikilinks out. Markdown links, task-list checkboxes, and reference
 * definitions all fail the end-anchor and need no special case.
 *
 * ## Why the refusal also requires a shrink
 *
 * Run across the live 487-page corpus this shape returns genuine placeholders
 * plus three benign false positives: an inline PowerShell subscript expression,
 * and two bracketed protocol-notation lines. Blocking on the shape alone would
 * refuse legitimate edits to those pages. So the refusal fires only when the
 * incoming compiled truth ALSO drops a material amount of the existing page —
 * the combination is what makes it a truncation rather than prose that happens
 * to be bracketed. A page that is holding steady or growing is never blocked,
 * and a new page (nothing to lose) is never blocked.
 */

/** A line must have at least this many characters between the brackets. */
const MIN_BRACKETED_LENGTH = 10;

/**
 * Cap on how many offending lines are reported. Bounds the size of the refusal
 * envelope; the guard's decision does not depend on the count.
 */
const MAX_REPORTED_LINES = 20;

/**
 * The write is refused only when at least this many characters disappear.
 * Keeps small pages — where a single bracketed line is a large fraction of the
 * body by construction — out of the guard entirely.
 */
export const PLACEHOLDER_MIN_REMOVED_CHARS = 500;

/**
 * The write is refused only when the incoming compiled truth retains less than
 * this fraction of the existing one. The three incident pages retained 0.24,
 * 0.35, and 0.56 of their prior content.
 */
export const PLACEHOLDER_MAX_RETAINED_RATIO = 0.75;

const PLACEHOLDER_LINE = new RegExp(`^\\[.{${MIN_BRACKETED_LENGTH},}\\]$`);

export interface PlaceholderTruncationAssessment {
  /** True only when a placeholder line AND a material shrink are both present. */
  shouldRefuse: boolean;
  /** The offending trimmed lines, capped at MAX_REPORTED_LINES. */
  placeholderLines: string[];
  /** Characters dropped from the existing compiled truth (negative when growing). */
  removedChars: number;
  /** Fraction of the existing compiled truth the incoming payload keeps. */
  retainedRatio: number;
}

/**
 * Every line of `text` whose entire trimmed content is one bracketed span of at
 * least MIN_BRACKETED_LENGTH characters. Wikilinks are excluded.
 */
export function findPlaceholderLines(text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[[')) continue;
    if (!PLACEHOLDER_LINE.test(trimmed)) continue;
    hits.push(trimmed);
    if (hits.length >= MAX_REPORTED_LINES) break;
  }
  return hits;
}

/**
 * Decide whether an incoming compiled truth is a placeholder-shaped truncation
 * of the existing one. Refuses only on placeholder AND material shrink; see the
 * module header for why both halves are required.
 */
export function assessPlaceholderTruncation(input: {
  incoming: string;
  existing: string | null | undefined;
}): PlaceholderTruncationAssessment {
  const existing = input.existing ?? '';
  const removedChars = existing.length - input.incoming.length;
  const retainedRatio = existing.length === 0 ? 1 : input.incoming.length / existing.length;
  const notTruncating =
    existing.length === 0 ||
    removedChars < PLACEHOLDER_MIN_REMOVED_CHARS ||
    retainedRatio >= PLACEHOLDER_MAX_RETAINED_RATIO;

  // Cheap gates first: no existing content, no shrink, or a shrink too small to
  // be a section-dropping rewrite. Skips the line scan on the common path.
  if (notTruncating) {
    return { shouldRefuse: false, placeholderLines: [], removedChars, retainedRatio };
  }

  const placeholderLines = findPlaceholderLines(input.incoming);
  return {
    shouldRefuse: placeholderLines.length > 0,
    placeholderLines,
    removedChars,
    retainedRatio,
  };
}

/**
 * The refusal message. Prefixed PLACEHOLDER_TRUNCATION so callers can branch on
 * it the same way they branch on FRONTMATTER_PARSE, and it names the offending
 * line verbatim so the agent can see what its own payload did.
 */
export function formatPlaceholderTruncationError(
  assessment: PlaceholderTruncationAssessment,
): string {
  const dropped = Math.round((1 - assessment.retainedRatio) * 100);
  const lines = assessment.placeholderLines.map((l) => `"${l}"`).join(', ');
  return (
    `PLACEHOLDER_TRUNCATION: the incoming compiled truth drops ${assessment.removedChars} ` +
    `characters (${dropped}% of the existing page) and contains a standalone bracketed ` +
    `placeholder line: ${lines}. That is the signature of an abbreviated rewrite that ` +
    `silently destroys content the page already held. Refusing the write — the page is ` +
    `unchanged. Send the FULL compiled truth, including every section you did not intend ` +
    `to edit. If the removal really is intended, retry with allow_truncation: true ` +
    `(put_page) or set GBRAIN_NO_TRUNCATION_GUARD=1 for a file-sync run.`
  );
}
