/**
 * Tests for `extractUndeclaredPrefixRefs` — the pure half of the entity_dirs
 * safety guard.
 *
 * `link_resolution.entity_dirs` is not just a recall knob. `runAutoLink` deletes
 * every reconcilable edge missing from the freshly-extracted desired set, so a
 * prefix that stops being declared stops being extractable and its existing
 * `link_source='markdown'` edges get hard-deleted. `links` has no tombstone
 * column.
 *
 * This detector is the mirror image of the dir-gated passes in
 * `extractEntityRefs`: it matches the same shapes with a WILDCARD prefix and
 * returns only the refs whose top-level dir is NOT declared — i.e. exactly the
 * references the extractor can no longer see.
 *
 * No DB, no resolver. Pure function.
 */

import { describe, test, expect } from 'bun:test';
import { extractUndeclaredPrefixRefs } from '../src/core/link-extraction.ts';

/** Sorted `dir/slug` pairs, so assertions don't depend on pass ordering. */
function pairs(content: string, entityDirs?: readonly string[]): string[] {
  return extractUndeclaredPrefixRefs(content, entityDirs)
    .map((r) => `${r.dir}::${r.slug}`)
    .sort();
}

describe('extractUndeclaredPrefixRefs', () => {
  describe('declared prefixes are invisible to it', () => {
    test('a canonical DEFAULT_ENTITY_DIRS prefix yields nothing', () => {
      expect(pairs('See [[people/alice-example]] for context.')).toEqual([]);
    });

    test('an operator-declared prefix yields nothing', () => {
      const c = 'See [[systems/write-semantics]] for context.';
      expect(pairs(c, ['systems'])).toEqual([]);
    });

    test('declaration is case- and whitespace-normalized like entity_dirs', () => {
      const c = 'See [[systems/write-semantics]].';
      expect(pairs(c, ['  SYSTEMS  '])).toEqual([]);
    });
  });

  describe('undeclared prefixes are reported, per shape', () => {
    test('unqualified wikilink', () => {
      expect(pairs('See [[sessions/2026-07-09-cutover]].')).toEqual([
        'sessions::sessions/2026-07-09-cutover',
      ]);
    });

    test('unqualified wikilink with a display alias', () => {
      expect(pairs('See [[sessions/cutover|the cutover]].')).toEqual([
        'sessions::sessions/cutover',
      ]);
    });

    test('qualified wikilink keeps the slug, not the source id', () => {
      expect(pairs('See [[wiki:sessions/cutover]].')).toEqual([
        'sessions::sessions/cutover',
      ]);
    });

    test('markdown link', () => {
      expect(pairs('See [the cutover](sessions/2026-07-09-cutover).')).toEqual([
        'sessions::sessions/2026-07-09-cutover',
      ]);
    });

    test('markdown link with ../ prefix and .md suffix', () => {
      expect(pairs('See [x](../../sessions/cutover.md).')).toEqual([
        'sessions::sessions/cutover',
      ]);
    });

    test('bare slug in prose', () => {
      expect(pairs('Recorded under sessions/2026-07-09-cutover last week.')).toEqual([
        'sessions::sessions/2026-07-09-cutover',
      ]);
    });

    test('a section anchor is stripped from the slug', () => {
      expect(pairs('See [[sessions/cutover#outcome]].')).toEqual([
        'sessions::sessions/cutover',
      ]);
    });
  });

  describe('the 2026-08-10 shape', () => {
    test('reports every undeclared prefix on a page that mixes them', () => {
      const content = [
        'Compiled truth references [[sessions/2026-07-17-backlog-sweep]]',
        'and [[sessions/2026-07-09-http-cutover]] plus',
        '[[systems/widget-service]] and [[systems/acme-relay]].',
      ].join('\n');
      // Neither prefix declared: all four refs are invisible to the extractor.
      expect(pairs(content)).toEqual([
        'sessions::sessions/2026-07-09-http-cutover',
        'sessions::sessions/2026-07-17-backlog-sweep',
        'systems::systems/acme-relay',
        'systems::systems/widget-service',
      ]);
      // Declaring both is what disarms it — this is the live config today.
      expect(pairs(content, ['sessions', 'systems'])).toEqual([]);
      // Declaring only one leaves the other armed.
      expect(pairs(content, ['sessions'])).toEqual([
        'systems::systems/acme-relay',
        'systems::systems/widget-service',
      ]);
    });
  });

  describe('things that must never be reported', () => {
    test('refs inside a fenced code block', () => {
      const content = '```\n[[sessions/cutover]]\n```\nNothing here.';
      expect(pairs(content)).toEqual([]);
    });

    test('refs inside inline code', () => {
      expect(pairs('Run `sessions/cutover` to see it.')).toEqual([]);
    });

    test('external URLs', () => {
      expect(pairs('See [docs](https://example.com/sessions/cutover).')).toEqual([]);
    });

    test('a bare wikilink with no prefix at all', () => {
      // No slash → no top-level dir → not an entity_dirs question.
      expect(pairs('See [[struktura]].')).toEqual([]);
    });

    test('a prefix that entity_dirs could never accept', () => {
      // ENTITY_DIR_RE rejects uppercase and leading punctuation, so reporting
      // these would hand the operator an unusable remedy.
      expect(pairs('See [[Sessions/cutover]] and [[_tmp/scratch]].')).toEqual([]);
    });
  });

  describe('dedup', () => {
    test('the same ref twice on a page collapses to one entry', () => {
      const content = 'See [[sessions/cutover]] and again [[sessions/cutover]].';
      expect(pairs(content)).toEqual(['sessions::sessions/cutover']);
    });
  });
});
