/**
 * Line-ending canonicalization for stored page content.
 *
 * Storage is LF-only. Every write into `compiled_truth` funnels through
 * `importFromContent`, which calls this before parsing, hashing, chunking,
 * or persisting — so put_page (local AND remote MCP), `gbrain capture`, and
 * the file sync/import path all land canonical bytes.
 *
 * Why this is a correctness fix and not cosmetics (2026-08-10 KB incident):
 * a Windows `gbrain capture --file` of a PowerShell-written file stored 549
 * CRLF pairs into `projects/hermes`, whose every prior revision had been pure
 * LF. Stored CRLF silently breaks search over compiled truth — a target
 * string spanning a line break is stored as `untracked infra\r\nscript` and
 * an `\n`-based pattern returns ZERO matches, which reads as "the stale text
 * is already gone" while it is sitting right there. Normalizing on the way in
 * is what makes a negative search result trustworthy.
 *
 * Both CRLF and a lone CR collapse to LF: a bare CR is just as invisible to a
 * line-oriented reader, and it is never meaningful as page content.
 */

/**
 * Collapse CRLF and lone CR to LF. Returns the input unchanged (same
 * reference, no allocation) when it holds no CR, which is the overwhelmingly
 * common case and keeps the hot sync path free of a full-page rewrite.
 */
export function normalizeLineEndings(content: string): string {
  return content.includes('\r') ? content.replace(/\r\n?/g, '\n') : content;
}
