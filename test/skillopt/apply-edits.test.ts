/**
 * SkillOpt apply-edits unit tests. Pure function — no fs, no engine.
 *
 * Covers D5 (frontmatter forbid), D9 (tagged result), shape-aware add/
 * replace/delete, ambiguous-match rejection, inside-code-fence guard.
 */

import { describe, expect, test } from 'bun:test';
import {
  applyEdit,
  applyEditBatch,
  isInsideCodeFence,
  splitFrontmatter,
} from '../../src/core/skillopt/apply-edits.ts';

const SAMPLE_SKILL = `---
name: example-skill
triggers:
  - "do the example"
brain_first: exempt
---

# Example Skill

When asked, run the pipeline.

## Steps

1. First, do X.
2. Then, do Y.

## Anti-patterns

Don't break the rule.
`;

describe('splitFrontmatter', () => {
  test('extracts body after closing fence', () => {
    const split = splitFrontmatter(SAMPLE_SKILL);
    expect(split.body).toContain('# Example Skill');
    expect(split.body).not.toContain('name: example-skill');
    expect(split.bodyStart).toBeGreaterThan(0);
  });

  test('text with no frontmatter returns whole text as body', () => {
    const split = splitFrontmatter('just body, no fence');
    expect(split.body).toBe('just body, no fence');
    expect(split.bodyStart).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CRLF tolerance
//
// An LF-only fence (`/^---\n[\s\S]*?\n---\n/`) cannot match a file that starts
// `---\r\n`, so a CRLF SKILL.md split as "no frontmatter": bodyStart stayed 0
// and the WHOLE file — frontmatter included — became the mutable body. That
// defeats D5 (frontmatter is immutable). On Windows `core.autocrlf=true` makes
// every checked-out SKILL.md CRLF, so this fired for the entire skills tree.
// ---------------------------------------------------------------------------

const CRLF_SKILL = SAMPLE_SKILL.replace(/\n/g, '\r\n');

describe('splitFrontmatter — CRLF', () => {
  test('splits a CRLF SKILL.md at the closing fence', () => {
    const split = splitFrontmatter(CRLF_SKILL);
    expect(split.body).toContain('# Example Skill');
    // The bug: frontmatter leaked into the mutable body.
    expect(split.body).not.toContain('name: example-skill');
    expect(split.body).not.toContain('brain_first: exempt');
    expect(split.bodyStart).toBeGreaterThan(0);
  });

  test('CRLF and LF split to the same body, modulo line endings', () => {
    const crlf = splitFrontmatter(CRLF_SKILL);
    const lf = splitFrontmatter(SAMPLE_SKILL);
    expect(crlf.body.replace(/\r\n/g, '\n')).toBe(lf.body);
    // bodyStart is an offset into the ORIGINAL text, so it must account for
    // the extra \r on each frontmatter line — proof we did not normalize.
    const crlfLinesConsumed = SAMPLE_SKILL.slice(0, lf.bodyStart).split('\n').length - 1;
    expect(crlf.bodyStart).toBe(lf.bodyStart + crlfLinesConsumed);
  });

  test('CRLF text with no frontmatter still returns the whole text as body', () => {
    const noFence = '# heading\r\n\r\nnot frontmatter\r\n';
    const split = splitFrontmatter(noFence);
    expect(split.body).toBe(noFence);
    expect(split.bodyStart).toBe(0);
  });

  test('applyEdit on a CRLF skill refuses an anchor inside the frontmatter (D5)', () => {
    // `brain_first: exempt` is a frontmatter line. With the frontmatter
    // wrongly folded into the body, this resolves as an exact-line anchor and
    // the optimizer happily writes INTO the frontmatter. Rejection is the
    // whole point of the split.
    const r = applyEdit(CRLF_SKILL, {
      op: 'add',
      anchor: 'brain_first: exempt',
      content: 'INJECTED',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('anchor_not_found');
  });

  test('applyEdit on a CRLF skill still edits the body and preserves the frontmatter', () => {
    const r = applyEdit(CRLF_SKILL, {
      op: 'add',
      anchor: '## Anti-patterns',
      content: '> **Convention:** see [conventions/foo.md](../conventions/foo.md).',
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      const fenceEnd = CRLF_SKILL.indexOf('\r\n---\r\n') + '\r\n---\r\n'.length;
      expect(r.newText.slice(0, fenceEnd)).toBe(CRLF_SKILL.slice(0, fenceEnd));
      expect(r.newText).toContain('conventions/foo.md');
    }
  });
});

describe('applyEdit (add)', () => {
  test('inserts content after a unique heading anchor', () => {
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'add',
      anchor: '## Anti-patterns',
      content: '> **Convention:** see [conventions/foo.md](../conventions/foo.md).',
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('## Anti-patterns');
      expect(r.newText).toContain('> **Convention:**');
    }
  });

  test('rejects when anchor not found', () => {
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'add',
      anchor: '## Nonexistent',
      content: 'new content',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('anchor_not_found');
  });

  test('rejects when anchor is ambiguous (multiple matches)', () => {
    const dup = SAMPLE_SKILL.replace('## Anti-patterns', '## Steps');
    const r = applyEdit(dup, { op: 'add', anchor: '## Steps', content: 'X' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('anchor_ambiguous');
  });
});

describe('applyEdit (replace)', () => {
  test('replaces unique target', () => {
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'replace',
      target: 'Don\'t break the rule.',
      replacement: 'Don\'t skip the validation step.',
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('skip the validation step');
      expect(r.newText).not.toContain('break the rule');
    }
  });

  test('rejects when target appears 0 times', () => {
    const r = applyEdit(SAMPLE_SKILL, { op: 'replace', target: 'nope', replacement: 'X' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('target_not_found');
  });

  test('rejects when target appears 2+ times', () => {
    const r = applyEdit(SAMPLE_SKILL, { op: 'replace', target: 'do', replacement: 'X' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('target_ambiguous');
  });
});

describe('applyEdit (delete)', () => {
  test('deletes unique target', () => {
    const r = applyEdit(SAMPLE_SKILL, { op: 'delete', target: 'Don\'t break the rule.' });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).not.toContain('break the rule');
    }
  });
});

// ---------------------------------------------------------------------------
// CRLF multi-line targets
//
// `replace`/`delete` locate their target with a raw `indexOf`, so a multi-line
// target authored with LF never matched a CRLF SKILL.md (and vice versa). The
// edit was then rejected as `target_not_found` — silently, from the caller's
// view, since rejection is a normal tagged outcome rather than an error.
// Single-line targets were unaffected. On Windows `core.autocrlf=true` makes
// every checked-out SKILL.md CRLF, so this was the common case there.
// ---------------------------------------------------------------------------

describe('applyEdit — CRLF multi-line targets', () => {
  const MULTI_LF = '1. First, do X.\n2. Then, do Y.';
  const MULTI_CRLF = MULTI_LF.replace(/\n/g, '\r\n');
  const strip = (s: string) => s.replace(/\r\n/g, '\n');

  test('multi-line replace applies to a CRLF skill with an LF-authored target', () => {
    const r = applyEdit(CRLF_SKILL, {
      op: 'replace',
      target: MULTI_LF,
      replacement: '1. First, do Z.',
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('do Z.');
      expect(r.newText).not.toContain('do X.');
      expect(r.newText).not.toContain('do Y.');
    }
  });

  test('multi-line delete applies to a CRLF skill with an LF-authored target', () => {
    const r = applyEdit(CRLF_SKILL, { op: 'delete', target: MULTI_LF });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).not.toContain('do X.');
      expect(r.newText).not.toContain('do Y.');
      // Frontmatter untouched (D5).
      expect(r.newText).toContain('name: example-skill');
    }
  });

  test('CRLF replace lands byte-identical to the LF replace, modulo line endings', () => {
    const edit = { op: 'replace' as const, target: MULTI_LF, replacement: '1. First, do Z.' };
    const crlf = applyEdit(CRLF_SKILL, edit);
    const lf = applyEdit(SAMPLE_SKILL, edit);
    expect(crlf.outcome).toBe('applied');
    expect(lf.outcome).toBe('applied');
    if (crlf.outcome === 'applied' && lf.outcome === 'applied') {
      expect(strip(crlf.newText)).toBe(lf.newText);
    }
  });

  test('CRLF delete lands byte-identical to the LF delete, modulo line endings', () => {
    // Guards the trailing-newline cut specifically: `\r\n` is ONE newline, so
    // trimming only the `\n` would strand a bare `\r` and leave a phantom
    // blank line the LF path never produces.
    const edit = { op: 'delete' as const, target: MULTI_LF };
    const crlf = applyEdit(CRLF_SKILL, edit);
    const lf = applyEdit(SAMPLE_SKILL, edit);
    expect(crlf.outcome).toBe('applied');
    expect(lf.outcome).toBe('applied');
    if (crlf.outcome === 'applied' && lf.outcome === 'applied') {
      expect(strip(crlf.newText)).toBe(lf.newText);
    }
  });

  test('a multi-line replacement is rewritten in the file\'s own line ending', () => {
    const r = applyEdit(CRLF_SKILL, {
      op: 'replace',
      target: MULTI_LF,
      replacement: '1. First, do Z.\n2. Then, do W.',
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('do Z.\r\n2. Then, do W.');
      // No lone LF anywhere: the edit must not splice mixed endings into the file.
      expect(r.newText.match(/(?<!\r)\n/g)).toBeNull();
    }
  });

  test('a CRLF-authored target still matches an LF skill (reverse direction)', () => {
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'replace',
      target: MULTI_CRLF,
      replacement: '1. First, do Z.',
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('do Z.');
      expect(r.newText.includes('\r')).toBe(false);
    }
  });

  test('a genuinely absent multi-line target still rejects as target_not_found', () => {
    const r = applyEdit(CRLF_SKILL, {
      op: 'replace',
      target: 'Not in this file.\nNot on any line.',
      replacement: 'X',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('target_not_found');
  });

  test('an absent multi-line delete target still rejects as target_not_found', () => {
    const r = applyEdit(CRLF_SKILL, { op: 'delete', target: 'Nope.\nStill nope.' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('target_not_found');
  });

  test('an ambiguous multi-line target rejects as ambiguous, not not-found', () => {
    // Proves the line-ending retry counts ALL matches rather than stopping at
    // the first — a retry that returned 1 would silently edit one of two.
    const dup = SAMPLE_SKILL.replace('Don\'t break the rule.', MULTI_LF).replace(/\n/g, '\r\n');
    const r = applyEdit(dup, { op: 'replace', target: MULTI_LF, replacement: 'X' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') {
      expect(r.reason).toBe('target_ambiguous');
      expect(r.detail).toBe('2 matches');
    }
  });
});

describe('D5: frontmatter mutation forbidden', () => {
  test('replace cannot target a frontmatter line', () => {
    // The optimizer tries to mutate `brain_first: exempt`. Body slice
    // doesn't contain it, so the target is "not found" from body's view.
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'replace',
      target: 'brain_first: exempt',
      replacement: 'brain_first: required',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('target_not_found');
  });

  test('add anchor on frontmatter line is invisible', () => {
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'add',
      anchor: 'name: example-skill',
      content: 'evil rewrite',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('anchor_not_found');
  });
});

describe('inside-code-fence guard', () => {
  const FENCED = `# Title

Some prose.

\`\`\`bash
gbrain skillopt foo
gbrain skillopt bar
\`\`\`

After fence.
`;

  test('rejects replace inside fence', () => {
    const r = applyEdit(FENCED, {
      op: 'replace',
      target: 'gbrain skillopt foo',
      replacement: 'gbrain skillopt zzz',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('inside_code_fence');
  });

  test('allows replace outside fence', () => {
    const r = applyEdit(FENCED, { op: 'replace', target: 'After fence.', replacement: 'After.' });
    expect(r.outcome).toBe('applied');
  });
});

describe('isInsideCodeFence', () => {
  const FENCED = '# Title\n\n```\ninside\n```\noutside\n';

  test('returns true for offsets between fence markers', () => {
    const inside = FENCED.indexOf('inside');
    expect(isInsideCodeFence(FENCED, inside)).toBe(true);
  });

  test('returns false for offsets after closing fence', () => {
    const outside = FENCED.indexOf('outside');
    expect(isInsideCodeFence(FENCED, outside)).toBe(false);
  });
});

describe('applyEditBatch with LR budget', () => {
  test('respects lrBudget — only first N apply', () => {
    const text = '---\nname: x\n---\n\nA\nB\nC\nD\n';
    const edits = [
      { op: 'replace' as const, target: 'A', replacement: 'AAA' },
      { op: 'replace' as const, target: 'B', replacement: 'BBB' },
      { op: 'replace' as const, target: 'C', replacement: 'CCC' },
    ];
    const r = applyEditBatch(text, edits, /* lrBudget */ 2);
    expect(r.results.filter((x) => x.outcome === 'applied')).toHaveLength(2);
    expect(r.results.filter((x) => x.outcome === 'rejected')).toHaveLength(1);
    expect(r.newText).toContain('AAA');
    expect(r.newText).toContain('BBB');
    expect(r.newText).not.toContain('CCC'); // budget exhausted
  });
});
