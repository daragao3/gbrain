/**
 * SkillOpt edit application — pure markdown patching with safety guards.
 *
 * Per the v0.41.20.0 plan decisions:
 *  D5: Forbid frontmatter mutation. Only the BODY slice (after the closing
 *      `---\n` fence) is mutable. Any edit whose anchor would resolve into
 *      the frontmatter is rejected.
 *  D9: Returns a tagged `EditResult` (`{outcome: 'applied' | 'rejected', ...}`).
 *      NEVER throws on rejection — throws are reserved for caller errors
 *      (e.g. dirty-tree, install-path) which are pre-flight gates handled
 *      at the orchestrator boundary.
 *
 * Three edit ops:
 *  - `add`: insert content after a unique anchor (heading title or quoted
 *    line). Refuses 0 or 2+ matches.
 *  - `replace`: exact-match find-and-replace. Refuses 0 or 2+ matches.
 *  - `delete`: remove an exact-match span. Refuses 0 or 2+ matches.
 *
 * Inside-code-fence guard: tracks fence depth line-by-line so edits inside
 * a ```fence``` are rejected (don't break example code blocks).
 *
 * Atomic writes happen at the caller (version-store.ts). This module is
 * pure: input is text, output is text + outcome.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { EditOp, EditResult, EditRejectionReason } from './types.ts';

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Apply one edit to skill text. Returns tagged result (D9).
 *
 * The input `text` MUST be the full SKILL.md content (frontmatter included).
 * We split off the frontmatter internally so the optimizer can never
 * accidentally mutate `triggers:`, `brain_first:`, etc. (D5).
 */
export function applyEdit(text: string, edit: EditOp): EditResult {
  const split = splitFrontmatter(text);
  const body = split.body;
  const bodyStart = split.bodyStart;

  // Apply the edit to the body slice only.
  const result = applyEditToBody(body, edit, bodyStart);
  if (result.outcome === 'rejected') return result;

  // Reassemble: frontmatter + new body.
  const newText = text.slice(0, bodyStart) + result.newText;
  return { outcome: 'applied', edit, newText };
}

/**
 * Apply a sequence of edits, respecting the LR budget. Edits are tried in
 * order; rejected edits are returned with their reasons. The first
 * `lrBudget` APPLIED edits commit; remaining edits beyond the budget are
 * silently skipped (returned as `{outcome: 'rejected', reason: 'no_change',
 * detail: 'lr_budget_exhausted'}`).
 *
 * Returns the final text AFTER all applied edits.
 */
export function applyEditBatch(
  text: string,
  edits: EditOp[],
  lrBudget: number,
): { newText: string; results: EditResult[] } {
  let cur = text;
  const results: EditResult[] = [];
  let appliedCount = 0;
  for (const edit of edits) {
    if (appliedCount >= lrBudget) {
      results.push({ outcome: 'rejected', edit, reason: 'no_change', detail: 'lr_budget_exhausted' });
      continue;
    }
    const r = applyEdit(cur, edit);
    results.push(r);
    if (r.outcome === 'applied') {
      cur = r.newText;
      appliedCount += 1;
    }
  }
  return { newText: cur, results };
}

// ─── Frontmatter split (D5) ───────────────────────────────────────────────

interface FrontmatterSplit {
  body: string;
  /** Offset into the original text where body begins (after closing `---\n`). */
  bodyStart: number;
}

/**
 * Split SKILL.md into (frontmatter, body). Returns body and the offset
 * where the body starts in the original text. When there's no frontmatter
 * fence, the whole text IS the body and bodyStart=0.
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  // Match the leading `---\n...frontmatter...\n---\n` block, CRLF-tolerant.
  //
  // An LF-only fence cannot match a file that starts `---\r\n`, so on Windows
  // (`core.autocrlf=true`) every SKILL.md parsed as "no frontmatter": bodyStart
  // stayed 0 and the whole file — frontmatter included — became the mutable
  // body, defeating the D5 frontmatter-immutability guarantee.
  //
  // Deliberately relaxing the fence rather than normalizing the text: bodyStart
  // is an offset into the ORIGINAL `text` (the caller reassembles with
  // `text.slice(0, bodyStart)`), so rewriting line endings here would corrupt
  // every offset. Downstream body matching already tolerates a trailing `\r`
  // (`findHeadingMatches` ends with `\s*$`; `findExactLineMatches` compares
  // `line.trim()`).
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!m) return { body: text, bodyStart: 0 };
  return { body: text.slice(m[0].length), bodyStart: m[0].length };
}

// ─── Body edit application ────────────────────────────────────────────────

function applyEditToBody(body: string, edit: EditOp, bodyStartOffset: number):
  | { outcome: 'applied'; newText: string }
  | { outcome: 'rejected'; edit: EditOp; reason: EditRejectionReason; detail?: string } {
  switch (edit.op) {
    case 'add':
      return applyAdd(body, edit, bodyStartOffset);
    case 'replace':
      return applyReplace(body, edit, bodyStartOffset);
    case 'delete':
      return applyDelete(body, edit, bodyStartOffset);
  }
}

function applyAdd(body: string, edit: EditOp & { op: 'add' }, bodyStartOffset: number):
  | { outcome: 'applied'; newText: string }
  | { outcome: 'rejected'; edit: EditOp; reason: EditRejectionReason; detail?: string } {
  const anchor = edit.anchor.trim();
  if (!anchor) return { outcome: 'rejected', edit, reason: 'anchor_not_found', detail: 'empty anchor' };

  // Heading-style anchors: "## Heading Title" or just "Heading Title".
  // Try heading match first; fallback to exact-line match.
  const headingMatches = findHeadingMatches(body, anchor);
  let insertAfter: number;
  if (headingMatches.length === 1) {
    insertAfter = headingMatches[0]!.endOfLine;
  } else if (headingMatches.length === 0) {
    const lineMatches = findExactLineMatches(body, anchor);
    if (lineMatches.length === 0) {
      return { outcome: 'rejected', edit, reason: 'anchor_not_found' };
    }
    if (lineMatches.length > 1) {
      return { outcome: 'rejected', edit, reason: 'anchor_ambiguous', detail: `${lineMatches.length} matches` };
    }
    insertAfter = lineMatches[0]!.endOfLine;
  } else {
    return { outcome: 'rejected', edit, reason: 'anchor_ambiguous', detail: `${headingMatches.length} heading matches` };
  }

  // Inside-code-fence guard: refuse if insert point is inside a ```fence```.
  if (isInsideCodeFence(body, insertAfter)) {
    return { outcome: 'rejected', edit, reason: 'inside_code_fence' };
  }

  // No need to check crosses_frontmatter — we're operating on body only,
  // and bodyStartOffset is preserved by the caller.
  void bodyStartOffset;

  // Insert content on a new line after the anchor.
  const insertion = '\n' + edit.content.trimEnd() + '\n';
  const newBody = body.slice(0, insertAfter) + insertion + body.slice(insertAfter);
  if (newBody === body) {
    return { outcome: 'rejected', edit, reason: 'no_change' };
  }
  return { outcome: 'applied', newText: newBody };
}

function applyReplace(body: string, edit: EditOp & { op: 'replace' }, bodyStartOffset: number):
  | { outcome: 'applied'; newText: string }
  | { outcome: 'rejected'; edit: EditOp; reason: EditRejectionReason; detail?: string } {
  if (!edit.target) return { outcome: 'rejected', edit, reason: 'target_not_found', detail: 'empty target' };

  const eol = detectEol(body);
  const { target, count: occurrences } = findTarget(body, edit.target, eol);
  if (occurrences === 0) return { outcome: 'rejected', edit, reason: 'target_not_found' };
  if (occurrences > 1) {
    return { outcome: 'rejected', edit, reason: 'target_ambiguous', detail: `${occurrences} matches` };
  }
  const matchIdx = body.indexOf(target);
  if (isInsideCodeFence(body, matchIdx)) {
    return { outcome: 'rejected', edit, reason: 'inside_code_fence' };
  }
  void bodyStartOffset;
  // Rewrite the replacement in the body's own line ending too, so a
  // multi-line replacement can't splice LF lines into a CRLF file.
  const replacement = toEol(edit.replacement, eol);
  const newBody = body.slice(0, matchIdx) + replacement + body.slice(matchIdx + target.length);
  if (newBody === body) {
    return { outcome: 'rejected', edit, reason: 'no_change' };
  }
  return { outcome: 'applied', newText: newBody };
}

function applyDelete(body: string, edit: EditOp & { op: 'delete' }, bodyStartOffset: number):
  | { outcome: 'applied'; newText: string }
  | { outcome: 'rejected'; edit: EditOp; reason: EditRejectionReason; detail?: string } {
  if (!edit.target) return { outcome: 'rejected', edit, reason: 'target_not_found', detail: 'empty target' };

  const eol = detectEol(body);
  const { target, count: occurrences } = findTarget(body, edit.target, eol);
  if (occurrences === 0) return { outcome: 'rejected', edit, reason: 'target_not_found' };
  if (occurrences > 1) {
    return { outcome: 'rejected', edit, reason: 'target_ambiguous', detail: `${occurrences} matches` };
  }
  const matchIdx = body.indexOf(target);
  if (isInsideCodeFence(body, matchIdx)) {
    return { outcome: 'rejected', edit, reason: 'inside_code_fence' };
  }
  void bodyStartOffset;
  // Delete the target plus a trailing newline if present (keep markdown tidy).
  // `\r\n` counts as ONE newline — cutting only the `\n` would strand a bare
  // `\r` and leave a phantom blank line the LF path never produces.
  const after = matchIdx + target.length;
  const trailingNl = body.startsWith('\r\n', after) ? 2 : body[after] === '\n' ? 1 : 0;
  const cutEnd = after + trailingNl;
  const newBody = body.slice(0, matchIdx) + body.slice(cutEnd);
  if (newBody === body) {
    return { outcome: 'rejected', edit, reason: 'no_change' };
  }
  return { outcome: 'applied', newText: newBody };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

interface MatchPos {
  startOfLine: number;
  endOfLine: number;
}

function findHeadingMatches(body: string, anchor: string): MatchPos[] {
  const heading = anchor.replace(/^#+\s*/, '').trim();
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`, 'gm');
  const out: MatchPos[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const startOfLine = match.index;
    const endOfLine = startOfLine + match[0].length;
    out.push({ startOfLine, endOfLine });
  }
  return out;
}

function findExactLineMatches(body: string, anchor: string): MatchPos[] {
  const target = anchor.trim();
  const lines = body.split('\n');
  const out: MatchPos[] = [];
  let offset = 0;
  for (const line of lines) {
    if (line.trim() === target) {
      out.push({ startOfLine: offset, endOfLine: offset + line.length });
    }
    offset += line.length + 1; // +1 for the \n
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
}

type Eol = '\r\n' | '\n';

/**
 * Dominant line ending of `text`. CRLF only when it actually outnumbers the
 * lone LFs, so a mostly-LF file with one stray `\r\n` still reads as LF.
 */
function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return '\n';
  const nl = (text.match(/\n/g) ?? []).length;
  return crlf > nl - crlf ? '\r\n' : '\n';
}

/** Rewrite every line ending in `s` as `eol`. Identity on single-line input. */
function toEol(s: string, eol: Eol): string {
  const lf = s.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/**
 * Locate `rawTarget` in `body`, tolerating a line-ending mismatch between the
 * two. `replace`/`delete` match their target with a raw `indexOf`, so a
 * multi-line target authored with LF never matches a CRLF SKILL.md (and vice
 * versa) — and the edit is then rejected as `target_not_found`, silently from
 * the caller's view since rejection is a normal tagged outcome. On Windows
 * `core.autocrlf=true` makes every checked-out SKILL.md CRLF, so that is the
 * common case there, not an edge case.
 *
 * The raw target is tried FIRST, so nothing changes whenever it already
 * matches; the normalized retry only rescues a miss. Normalizing the target
 * rather than the body is deliberate: `splitFrontmatter` returns `bodyStart` as
 * an offset into the ORIGINAL text and `applyEdit` reassembles with
 * `text.slice(0, bodyStart) + newText`, so rewriting the body in place would
 * desynchronize the offset and corrupt the reassembly.
 *
 * Returns the target variant that actually matched, so the caller can slice
 * with the right length.
 */
function findTarget(body: string, rawTarget: string, eol: Eol): { target: string; count: number } {
  const count = countOccurrences(body, rawTarget);
  if (count > 0) return { target: rawTarget, count };
  const normalized = toEol(rawTarget, eol);
  if (normalized === rawTarget) return { target: rawTarget, count: 0 };
  return { target: normalized, count: countOccurrences(body, normalized) };
}

/**
 * Detect whether `offset` falls inside a fenced code block (``` ... ```).
 * Tracks fence depth line-by-line. Tolerates malformed fences (unclosed
 * blocks) by treating them as "everything after the opening fence is inside".
 */
export function isInsideCodeFence(body: string, offset: number): boolean {
  if (offset < 0 || offset > body.length) return false;
  const before = body.slice(0, offset);
  const lines = before.split('\n');
  let inFence = false;
  for (const line of lines) {
    if (line.match(/^```/)) inFence = !inFence;
  }
  return inFence;
}

// ─── Pre-flight gates (called by orchestrator before applyEdit loop) ──────

/**
 * Check git working-tree status for a specific file. Returns:
 *  - 'clean': file matches HEAD or doesn't exist in git.
 *  - 'dirty': file has uncommitted changes.
 *  - 'not_a_repo': dir is not in a git repo (no gate fires).
 *
 * Mirrors src/core/skill-fix-gates.ts:getWorkingTreeStatus.
 */
export function getWorkingTreeStatusForFile(filePath: string): 'clean' | 'dirty' | 'not_a_repo' {
  try {
    const cwd = dirname(filePath);
    // First check we're in a repo.
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'pipe' });
    } catch {
      return 'not_a_repo';
    }
    // Then check status on this specific file.
    const out = execFileSync('git', ['status', '--porcelain', '--', filePath], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    return out.length === 0 ? 'clean' : 'dirty';
  } catch {
    return 'not_a_repo';
  }
}

/**
 * Atomic write via .tmp + fsync + rename. Mirrors version-store.ts pattern
 * but provided here for ad-hoc callers (orchestrator uses version-store).
 */
export function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}
