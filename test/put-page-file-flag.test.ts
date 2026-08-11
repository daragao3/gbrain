/**
 * `gbrain put <slug> --file PATH` — CLI-only file input.
 *
 * Motivation: passing a large body as `--content` kills the process before any
 * gbrain code runs. `~/.bun/bin/gbrain.exe` is Bun's ~15KB Windows binstub
 * shim, and it faults with an access violation (0xC0000005 / exit 3221225477,
 * no stdout, no write) once the forwarded command line passes ~16-20KB. Since
 * the fault is in the shim, gbrain cannot turn it into a real error — the only
 * fix is a path that keeps the body out of argv.
 *
 * The flag is deliberately CLI-only (handled in cli.ts, never added to
 * `op.params`) so the MCP surface gains no local-file-read primitive.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';

const putPage = operations.find(op => op.name === 'put_page')!;

describe('put --file', () => {
  test('is NOT an op param — MCP callers cannot name a local path', () => {
    expect(putPage.params.file).toBeUndefined();
    expect(Object.keys(putPage.params)).toContain('content');
  });

  test('the empty-content hint points at --file, not the capture workaround', async () => {
    // The hint is what an agent reads after refusing to blank a page; it must
    // route to the path that actually survives a large body.
    const engine = {
      getPage: async () => ({ compiled_truth: 'existing prose', timeline: '' }),
    };
    let suggestion = '';
    try {
      await putPage.handler(
        { engine, remote: false } as never,
        { slug: 'systems/x', content: '   ' },
      );
      throw new Error('expected put_page to refuse blanking a non-empty page');
    } catch (err) {
      expect((err as { name?: string }).name).toBe('OperationError');
      suggestion = (err as { suggestion?: string }).suggestion ?? '';
    }
    expect(suggestion).toContain('--file');
    expect(suggestion).not.toContain('put has no --file flag');
  });

  test('parseOpArgs carries --file through without an op-param declaration', async () => {
    const { parseOpArgs } = await import('../src/cli.ts');
    const params = parseOpArgs(putPage, ['systems/x', '--file', 'C:/tmp/body.md']);
    expect(params.slug).toBe('systems/x');
    expect(params.file).toBe('C:/tmp/body.md');
    // `content` is filled by the cli.ts transform, not by the parser.
    expect(params.content).toBeUndefined();
  });

  test('a body far past the argv crash threshold round-trips through a file', () => {
    // 24KB — comfortably past the ~16-20KB shim fault point that motivated the
    // flag. Reading it as a Buffer is the whole point: no argv involved.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-put-file-'));
    const path = join(dir, 'body.md');
    const body = '---\ntitle: Big\ntype: system\n---\n\n'
      + 'Prose paragraph with **bold** and a wikilink.\n\n'.repeat(600);
    expect(body.length).toBeGreaterThan(24_000);
    writeFileSync(path, body, 'utf-8');

    const roundTripped = require('fs').readFileSync(path).toString('utf-8');
    expect(roundTripped).toBe(body);
  });
});
