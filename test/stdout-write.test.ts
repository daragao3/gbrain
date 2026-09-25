/**
 * writeStdout on a real spawned Bun process.
 *
 * `gbrain check-update --json` reached CI as truncated JSON ("JSON Parse
 * error: Unterminated string") because console.log into a pipe stalls at the
 * first full pipe buffer once process.stdout carries an 'error' listener, as
 * every CLI run's does (see src/core/stdout-write.ts). This pins the fix: a
 * payload well past one pipe buffer, a reader that starts late, and the bytes
 * must all arrive and parse.
 */

import { describe, test, expect } from 'bun:test';
import { resolve } from 'path';

const HARNESS = resolve(import.meta.dir, 'fixtures', 'stdout-write-harness.ts');

describe('writeStdout on a real Bun process', () => {
  test('a payload far past one pipe buffer arrives whole to a late reader', async () => {
    const SIZE = 1_000_000;
    const proc = Bun.spawn(['bun', 'run', HARNESS], {
      env: { ...process.env, HARNESS_BYTES: String(SIZE) },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    // Start consuming only after the writer has filled the pipe buffer and hit
    // backpressure -- the condition console.log does not survive.
    await Bun.sleep(1000);
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out).blob.length).toBe(SIZE);
  }, 30_000);
});
