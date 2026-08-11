import { describe, test, expect } from 'bun:test';
import {
  extractEntityRefs,
  extractPageLinks,
  normalizeEntityDirs,
  buildDirPattern,
  parseTimelineEntries,
  isRemoteReconcileEnabled,
  getExtraEntityDirs,
  DEFAULT_ENTITY_DIRS,
  type SlugResolver,
} from '../src/core/link-extraction.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

/** Minimal engine stub: only getConfig is exercised by the flag readers. */
function configEngine(cfg: Record<string, string | null>): BrainEngine {
  return {
    getConfig: async (k: string) => (k in cfg ? cfg[k] : null),
  } as unknown as BrainEngine;
}

// ─── entity dirs ────────────────────────────────────────────────

describe('normalizeEntityDirs', () => {
  test('drops dirs already covered by the canonical set', () => {
    expect(normalizeEntityDirs(['people', 'companies'])).toEqual([]);
  });

  test('normalizes case and surrounding whitespace', () => {
    expect(normalizeEntityDirs([' Sessions ', 'SYSTEMS'])).toEqual(['sessions', 'systems']);
  });

  test('rejects anything carrying regex metacharacters', () => {
    // These strings are interpolated straight into a RegExp. An accepted
    // one is pattern injection across every extraction on the brain, so the
    // rule is reject-not-escape.
    const out = normalizeEntityDirs(['a|b', 'x)(y', '.*', 'foo/bar', '-lead', '']);
    expect(out).toEqual([]);
  });

  test('deduplicates and orders longest-first for a stable cache key', () => {
    expect(normalizeEntityDirs(['ab', 'sessions', 'ab', 'systems']))
      .toEqual(['sessions', 'systems', 'ab']);
  });

  test('buildDirPattern returns the canonical pattern when nothing is added', () => {
    expect(buildDirPattern([])).toBe(buildDirPattern(undefined));
    expect(buildDirPattern([])).toContain('people');
  });

  test('buildDirPattern keeps every canonical dir when extending', () => {
    const p = buildDirPattern(['sessions']);
    expect(p).toContain('sessions');
    for (const d of DEFAULT_ENTITY_DIRS) expect(p).toContain(d);
  });
});

describe('extractEntityRefs with extra entity dirs', () => {
  const body = 'See [[sessions/2026-07-09-cutover]] and [[systems/mempalace-mcp]].';

  test('without config, non-canonical dirs fall through to the generic pass', () => {
    // This is the silent-drop that leaves the graph unbuilt: the refs are
    // found but tagged needsResolution, and the caller drops them unless
    // global_basename is on.
    const refs = extractEntityRefs(body);
    expect(refs).toHaveLength(2);
    expect(refs.every(r => r.needsResolution === true)).toBe(true);
  });

  test('with config, they resolve as ordinary dir-gated wikilinks', () => {
    const refs = extractEntityRefs(body, { entityDirs: ['sessions', 'systems'] });
    expect(refs).toHaveLength(2);
    expect(refs.every(r => r.needsResolution)).toBe(false);
    expect(refs.map(r => r.slug).sort()).toEqual([
      'sessions/2026-07-09-cutover',
      'systems/mempalace-mcp',
    ]);
  });

  test('extra dirs do not disturb the canonical ones', () => {
    const refs = extractEntityRefs('[[people/alice]] and [[sessions/x]]', {
      entityDirs: ['sessions'],
    });
    expect(refs.map(r => r.slug).sort()).toEqual(['people/alice', 'sessions/x']);
    expect(refs.every(r => r.needsResolution)).toBe(false);
  });

  test('code spans are still stripped before any dir matching', () => {
    const refs = extractEntityRefs('`[[sessions/in-code]]`', { entityDirs: ['sessions'] });
    expect(refs).toHaveLength(0);
  });
});

// ─── wikilinkOnly (the reduced-trust extraction subset) ─────────

describe('extractPageLinks wikilinkOnly', () => {
  const content = [
    'Explicit [[people/alice]] wikilink.',
    'A markdown link to [Bob](people/bob).',
    'Bare prose mentioning people/carol in passing.',
  ].join('\n');

  test('full mode picks up wikilink, markdown link and bare slug', () => {
    return extractPageLinks('notes/x', content, {}, 'note', nullResolver).then(({ candidates }) => {
      const targets = candidates.map(c => c.targetSlug).sort();
      expect(targets).toEqual(['people/alice', 'people/bob', 'people/carol']);
    });
  });

  test('wikilinkOnly keeps ONLY the explicit wikilink', async () => {
    const { candidates } = await extractPageLinks(
      'notes/x', content, {}, 'note', nullResolver, { wikilinkOnly: true },
    );
    expect(candidates.map(c => c.targetSlug)).toEqual(['people/alice']);
  });

  test('wikilinkOnly drops the bare-slug scan — the injection surface', async () => {
    // The trust gate exists because this scan matches an entity path
    // ANYWHERE in page text, so quoted or pasted content can plant an
    // outbound edge. A reduced-trust caller must never reach it.
    const injected = 'Quoted from an untrusted doc: "see meetings/board-q1 for details".';
    const { candidates } = await extractPageLinks(
      'notes/x', injected, {}, 'note', nullResolver, { wikilinkOnly: true },
    );
    expect(candidates).toHaveLength(0);

    const full = await extractPageLinks('notes/x', injected, {}, 'note', nullResolver);
    expect(full.candidates.map(c => c.targetSlug)).toEqual(['meetings/board-q1']);
  });

  test('wikilinkOnly drops frontmatter-derived edges', async () => {
    const resolver: SlugResolver = { resolve: async () => 'companies/acme' };
    const fm = { company: 'Acme' };
    const { candidates } = await extractPageLinks(
      'people/dave', 'No links in the body.', fm, 'person', resolver, { wikilinkOnly: true },
    );
    expect(candidates).toHaveLength(0);

    const full = await extractPageLinks(
      'people/dave', 'No links in the body.', fm, 'person', resolver,
    );
    expect(full.candidates.length).toBeGreaterThan(0);
  });

  test('wikilinkOnly composes with extra entity dirs', async () => {
    const { candidates } = await extractPageLinks(
      'notes/x',
      'Ref [[sessions/2026-07-09-cutover]] plus prose sessions/other-page here.',
      {}, 'note', nullResolver,
      { wikilinkOnly: true, entityDirs: ['sessions'] },
    );
    // The wikilink lands; the bare mention of the same dir does not.
    expect(candidates.map(c => c.targetSlug)).toEqual(['sessions/2026-07-09-cutover']);
  });
});

// ─── plain-date timeline rows ───────────────────────────────────

describe('parseTimelineEntries plain-date rows', () => {
  test('parses an em-dash separated plain date row', () => {
    const out = parseTimelineEntries('## Timeline\n- 2026-07-27 — shipped the fix\n');
    expect(out).toEqual([{ date: '2026-07-27', summary: 'shipped the fix', detail: '' }]);
  });

  test('still parses the canonical bold-date row', () => {
    const out = parseTimelineEntries('- **2026-07-27** | shipped the fix\n');
    expect(out).toEqual([{ date: '2026-07-27', summary: 'shipped the fix', detail: '' }]);
  });

  test.each([
    ['spaced hyphen', '- 2026-07-27 - shipped the fix'],
    ['colon', '- 2026-07-27: shipped the fix'],
    ['pipe', '- 2026-07-27 | shipped the fix'],
    ['en dash', '- 2026-07-27 – shipped the fix'],
    ['asterisk bullet', '* 2026-07-27 — shipped the fix'],
  ])('accepts %s', (_label, line) => {
    const out = parseTimelineEntries(`## Timeline\n${line}\n`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ date: '2026-07-27', summary: 'shipped the fix' });
  });

  test('accepts a word qualifier between the date and the separator', () => {
    const out = parseTimelineEntries('## Timeline\n- 2026-07-11 late — evening pass\n');
    expect(out).toEqual([{ date: '2026-07-11', summary: 'evening pass', detail: '' }]);
  });

  test('a clock time in the qualifier is not mistaken for the separator', () => {
    // `~16:45 ET` contains a colon. If the colon arm matched it, the row
    // would parse as summary "45 ET — the real summary" — a corrupted entry
    // that still looks plausible in the DB.
    const out = parseTimelineEntries('## Timeline\n- 2026-07-16 ~16:45 ET — the real summary\n');
    expect(out).toEqual([{ date: '2026-07-16', summary: 'the real summary', detail: '' }]);
  });

  test('a qualifier row does not get swallowed into the previous row', () => {
    // The regression this protects: when a qualifier row fails to match,
    // the detail-collection loop absorbs it into the row above, producing
    // one double-length entry instead of two.
    const out = parseTimelineEntries([
      '## Timeline',
      '- 2026-07-10 — first entry',
      '- 2026-07-11 late — second entry',
    ].join('\n'));
    expect(out).toHaveLength(2);
    expect(out[0].summary).toBe('first entry');
    expect(out[0].detail).toBe('');
    expect(out[1].summary).toBe('second entry');
  });

  test('collects continuation lines as detail', () => {
    const out = parseTimelineEntries([
      '## Timeline',
      '- 2026-07-27 — headline',
      '  wrapped continuation text',
    ].join('\n'));
    expect(out).toHaveLength(1);
    expect(out[0].detail).toBe('wrapped continuation text');
  });

  test('ignores a date row with no separator', () => {
    expect(parseTimelineEntries('- 2026-07-27 shipped the fix\n')).toEqual([]);
  });

  test('ignores an unbulleted prose line that merely opens with a date', () => {
    expect(parseTimelineEntries('2026-07-27 — this is a paragraph, not a list row\n')).toEqual([]);
  });

  test('rejects impossible calendar dates', () => {
    expect(parseTimelineEntries('- 2026-02-30 — nope\n')).toEqual([]);
    expect(parseTimelineEntries('- 2026-13-01 — nope\n')).toEqual([]);
  });

  test('does not double-count a row that also carries a Source citation', () => {
    const out = parseTimelineEntries('- 2026-07-27 — shipped [Source: notes, 2026-07-27]\n');
    expect(out).toHaveLength(1);
  });
});

// ─── flag readers ───────────────────────────────────────────────

describe('isRemoteReconcileEnabled', () => {
  test('defaults to false — fail-closed, opt-in per brain', async () => {
    expect(await isRemoteReconcileEnabled(configEngine({}))).toBe(false);
  });

  test('reads truthy values from the DB plane', async () => {
    for (const v of ['1', 'true', 'yes', 'on', ' ON ']) {
      expect(await isRemoteReconcileEnabled(
        configEngine({ 'link_resolution.remote_reconcile': v }),
      )).toBe(true);
    }
  });

  test('treats anything else as off', async () => {
    for (const v of ['0', 'false', 'no', 'off', 'maybe', '']) {
      expect(await isRemoteReconcileEnabled(
        configEngine({ 'link_resolution.remote_reconcile': v }),
      )).toBe(false);
    }
  });

  test('env var overrides the DB plane in both directions', async () => {
    const on = configEngine({ 'link_resolution.remote_reconcile': 'on' });
    const off = configEngine({});
    await withEnv({ GBRAIN_LINK_RESOLUTION_REMOTE_RECONCILE: '0' }, async () => {
      expect(await isRemoteReconcileEnabled(on)).toBe(false);
    });
    await withEnv({ GBRAIN_LINK_RESOLUTION_REMOTE_RECONCILE: '1' }, async () => {
      expect(await isRemoteReconcileEnabled(off)).toBe(true);
    });
  });
});

describe('getExtraEntityDirs', () => {
  test('defaults to empty so existing brains are untouched', async () => {
    expect(await getExtraEntityDirs(configEngine({}))).toEqual([]);
  });

  test('parses and sanitizes a comma-separated config value', async () => {
    const dirs = await getExtraEntityDirs(configEngine({
      'link_resolution.entity_dirs': 'sessions, systems , people, a|b',
    }));
    // `people` is already canonical and `a|b` is rejected outright.
    expect(dirs).toEqual(['sessions', 'systems']);
  });

  test('env var overrides the DB plane', async () => {
    const engine = configEngine({ 'link_resolution.entity_dirs': 'sessions' });
    await withEnv({ GBRAIN_LINK_RESOLUTION_ENTITY_DIRS: 'markets' }, async () => {
      expect(await getExtraEntityDirs(engine)).toEqual(['markets']);
    });
  });
});
