import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
};
const lockfile = readFileSync(join(repoRoot, 'bun.lock'), 'utf8');

function resolvedVersion(packageName: string): string {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = lockfile.match(new RegExp(`"${escaped}": \\["${escaped}@([0-9.]+)"`));
  expect(match, `${packageName} must be resolved in bun.lock`).not.toBeNull();
  return match![1]!;
}

function expectAtLeast(actual: string, floor: string): void {
  const parts = (version: string) => version.split('.').map(Number);
  const actualParts = parts(actual);
  const floorParts = parts(floor);
  const comparison = actualParts.reduce(
    (result, value, index) => result || Math.sign(value - floorParts[index]!),
    0,
  );
  expect(comparison, `expected ${actual} to be at least ${floor}`).toBeGreaterThanOrEqual(0);
}

describe('dependency security floors', () => {
  test('keeps the MCP transport stack on an audited Hono v2-compatible release', () => {
    expect(manifest.dependencies['@modelcontextprotocol/sdk']).toBe('1.30.0');
    expect(manifest.overrides['@hono/node-server']).toStartWith('^2.');
    expectAtLeast(resolvedVersion('@modelcontextprotocol/sdk'), '1.30.0');
    expectAtLeast(resolvedVersion('@hono/node-server'), '2.0.12');
  });

  test('keeps body-parser above its invalid-limit fix', () => {
    expectAtLeast(resolvedVersion('body-parser'), '2.3.0');
  });

  test('keeps fast-uri above its malformed-authority fix', () => {
    expectAtLeast(resolvedVersion('fast-uri'), '3.1.4');
  });
});
