/**
 * Frontmatter parse-failure guard — DISK-SIDE path (follow-up to ab8d0d3f).
 *
 * ab8d0d3f closed the API path (`put_page` → `importFromContent`). This file
 * covers the two surfaces that were left open by that commit:
 *
 *   1. `importFromFile` (what `gbrain sync` / `gbrain import` drive). It
 *      delegates to `importFromContent`, so it INHERITS the refusal — but
 *      nothing pinned that. These tests lock the inheritance in place so a
 *      future refactor of importFromFile (e.g. inlining the write) cannot
 *      silently reintroduce the metadata reset from disk.
 *
 *   2. `collectValidationErrors`' YAML_PARSE check — the surface `gbrain lint`
 *      and `gbrain frontmatter` consume. It fires off `ctx.yamlParseError`,
 *      i.e. off gray-matter THROWING, which is exactly the signal ab8d0d3f
 *      documented as unreliable: gray-matter caches `matter.cache[content]`
 *      BEFORE parsing, so only the FIRST parse of a given payload throws and
 *      every byte-identical repeat returns `data:{}` with no throw at all.
 *      A repeat parse therefore reported a CLEAN lint on a broken file.
 *
 * Triggers are the two field-observed ones from the 2026-07-23 KB audit:
 * a leading space before a mapping key, and an unquoted colon in a scalar.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { parseMarkdown } from '../src/core/markdown.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromFile } from '../src/core/import-file.ts';

const F = '---';

// Distinct payloads from the ones in put-page-frontmatter-parse-guard.test.ts.
// gray-matter's cache is keyed on exact content and is process-global, so
// reusing a payload across test files would let the other file's parse decide
// whether the throw happens here.

// Trigger 1 — leading space makes ` type: signal` an invalid mapping entry.
const DISK_LEADING_SPACE = `${F}\ntitle: Disk side guard\n type: signal\ntags: [disk, guard]\n${F}\n\nDisk body.\n`;

// Trigger 2 — unquoted colon inside a scalar.
const DISK_UNQUOTED_COLON = `${F}\ntitle: Disk regime: unquoted colon case\ntype: signal\n${F}\n\nDisk body.\n`;

describe('lint surface: YAML_PARSE must not depend on gray-matter throwing', () => {
  test('reports YAML_PARSE on the FIRST parse of broken frontmatter', () => {
    const parsed = parseMarkdown(DISK_LEADING_SPACE, 'a/first.md', { validate: true });
    expect(parsed.errors!.map((e) => e.code)).toContain('YAML_PARSE');
  });

  // THE GAP: gray-matter cached an unparsed entry on the call above, so this
  // second call never throws, ctx.yamlParseError is null, and check 6 stays
  // silent — `gbrain lint` reports the file clean.
  test('still reports YAML_PARSE on a REPEAT parse of identical content', () => {
    const second = parseMarkdown(DISK_LEADING_SPACE, 'a/second.md', { validate: true });
    const third = parseMarkdown(DISK_LEADING_SPACE, 'a/third.md', { validate: true });
    expect(second.errors!.map((e) => e.code)).toContain('YAML_PARSE');
    expect(third.errors!.map((e) => e.code)).toContain('YAML_PARSE');
  });

  test('unquoted-colon trigger is reported on repeat parses too', () => {
    parseMarkdown(DISK_UNQUOTED_COLON, 'b/first.md', { validate: true });
    const repeat = parseMarkdown(DISK_UNQUOTED_COLON, 'b/second.md', { validate: true });
    expect(repeat.errors!.map((e) => e.code)).toContain('YAML_PARSE');
  });

  test('well-formed frontmatter reports no YAML_PARSE', () => {
    const ok = parseMarkdown(`${F}\ntype: signal\ntitle: Fine\n${F}\n\nbody\n`, 'c/ok.md', {
      validate: true,
    });
    expect(ok.errors!.map((e) => e.code)).not.toContain('YAML_PARSE');
  });

  test('a file with no frontmatter reports no YAML_PARSE', () => {
    const none = parseMarkdown('# Heading\n\nbody\n', 'c/none.md', { validate: true });
    expect(none.errors!.map((e) => e.code)).not.toContain('YAML_PARSE');
  });
});

describe('importFromFile refuses a disk file with unparseable frontmatter', () => {
  let engine: PGLiteEngine;
  let dir: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    resetGateway();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-fm-disk-'));
  }, 120_000);

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): string {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    return abs;
  }

  test('an existing page keeps its title/type/tags when the file on disk breaks', async () => {
    const rel = 'signals/disk-guard.md';
    const good = `${F}\ntitle: Disk side guard\ntype: signal\ntags: [disk, guard]\n${F}\n\nOriginal body.\n`;
    const abs = writeFile(rel, good);

    const seeded = await importFromFile(engine, abs, rel, { noEmbed: true, sourceId: 'default' });
    expect(seeded.status).toBe('imported');

    // The file is edited to a broken state and re-synced.
    writeFileSync(abs, DISK_LEADING_SPACE, 'utf-8');
    const result = await importFromFile(engine, abs, rel, { noEmbed: true, sourceId: 'default' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('FRONTMATTER_PARSE');

    const page = await engine.getPage('signals/disk-guard', { sourceId: 'default' });
    expect(page!.title).toBe('Disk side guard');
    expect(page!.type).toBe('signal');
    expect(page!.compiled_truth).toContain('Original body.');
    const tags = await engine.getTags('signals/disk-guard', { sourceId: 'default' });
    expect(tags.sort()).toEqual(['disk', 'guard']);
  });

  test('a NEW file with broken frontmatter is not imported at all', async () => {
    const rel = 'signals/disk-new.md';
    const abs = writeFile(rel, DISK_UNQUOTED_COLON);

    const result = await importFromFile(engine, abs, rel, { noEmbed: true, sourceId: 'default' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('FRONTMATTER_PARSE');
    expect(await engine.getPage('signals/disk-new', { sourceId: 'default' })).toBeNull();
  });

  test('the refusal carries a non-empty error the sync ledger can record', async () => {
    // runImport pushes {path, error} into the failure ledger for any
    // non-'imported' result carrying an error !== 'unchanged'. An empty or
    // 'unchanged' error string would make the file vanish from the ledger AND
    // let sync.last_commit advance past it.
    const rel = 'signals/ledger.md';
    const abs = writeFile(rel, DISK_LEADING_SPACE);

    const result = await importFromFile(engine, abs, rel, { noEmbed: true, sourceId: 'default' });

    expect(result.status).not.toBe('imported');
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe('unchanged');
    expect(result.error!.length).toBeGreaterThan(0);
  });

  test('a well-formed file on disk still imports normally', async () => {
    const rel = 'signals/fine.md';
    const abs = writeFile(rel, `${F}\ntitle: Fine Disk Page\ntype: signal\n${F}\n\nBody.\n`);

    const result = await importFromFile(engine, abs, rel, { noEmbed: true, sourceId: 'default' });

    expect(result.status).toBe('imported');
    const page = await engine.getPage('signals/fine', { sourceId: 'default' });
    expect(page!.title).toBe('Fine Disk Page');
  });
});
