import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { isAbsolute, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotEligible, resolveSnapshotPath } from '../src/core/pglite-snapshot.ts';
import { tryLoadSnapshot } from '../src/core/pglite-engine.ts';
import { REPO_ROOT } from './helpers/repo-root.ts';

const never = () => false;
const always = () => true;

describe('snapshotEligible', () => {
  test('in-memory (no dataDir) stays eligible regardless of the seed flag', () => {
    expect(snapshotEligible(undefined, {}, never)).toBe(true);
    expect(snapshotEligible(undefined, { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '1' }, never)).toBe(true);
  });

  test('file-backed WITHOUT the seed flag is not eligible', () => {
    expect(snapshotEligible('/tmp/brain.pglite', {}, never)).toBe(false);
  });

  test('file-backed WITH the flag and an empty dataDir is eligible', () => {
    expect(
      snapshotEligible('/tmp/brain.pglite', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '1' }, never),
    ).toBe(true);
  });

  test('file-backed WITH the flag but an existing cluster is not eligible', () => {
    expect(
      snapshotEligible('/tmp/brain.pglite', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '1' }, always),
    ).toBe(false);
  });

  test('the flag must be exactly "1"', () => {
    expect(snapshotEligible('/tmp/b', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: 'true' }, never)).toBe(false);
    expect(snapshotEligible('/tmp/b', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '0' }, never)).toBe(false);
    expect(snapshotEligible('/tmp/b', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '' }, never)).toBe(false);
  });

  test('emptiness is decided by PG_VERSION at the dataDir root', () => {
    const seen: string[] = [];
    snapshotEligible('/tmp/brain.pglite', { GBRAIN_PGLITE_SNAPSHOT_SEED_FILE: '1' }, (p) => {
      seen.push(p);
      return false;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].replace(/\\/g, '/')).toBe('/tmp/brain.pglite/PG_VERSION');
  });
});

describe('resolveSnapshotPath', () => {
  test('absolute paths pass through unchanged', () => {
    const abs = process.platform === 'win32' ? 'C:\\snap\\x.tar' : '/snap/x.tar';
    expect(resolveSnapshotPath(abs)).toBe(abs);
  });

  test('a relative path becomes absolute', () => {
    const out = resolveSnapshotPath('test/fixtures/pglite-snapshot.tar');
    expect(isAbsolute(out)).toBe(true);
    expect(out).toContain('pglite-snapshot.tar');
  });

  // The finding this guards: the env var holds a RELATIVE path, so a test that
  // spawns the CLI from a tmpdir cwd would silently miss the snapshot and fall
  // back to a slow boot — reporting "no win" for an unrelated reason.
  test('a relative path resolves identically from an unrelated cwd', () => {
    const fromRepo = resolveSnapshotPath('test/fixtures/pglite-snapshot.tar', undefined, REPO_ROOT);
    const fromTmp = resolveSnapshotPath('test/fixtures/pglite-snapshot.tar', undefined, tmpdir());
    expect(fromRepo).toBe(fromTmp);
  });
});

describe('tryLoadSnapshot staleness guard', () => {
  // A stale snapshot restoring an out-of-date schema is far worse than a slow
  // boot, so every one of these MUST return null rather than a Blob, and MUST
  // NOT throw — the engine treats the snapshot as an optimization, never as
  // authoritative.
  test('missing tar returns null', () => {
    expect(tryLoadSnapshot('/definitely/not/here/snap.tar')).toBeNull();
  });

  test('tar present but .version sidecar missing returns null', () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'snap-stale-'));
    try {
      const tar = joinPath(dir, 'snap.tar');
      writeFileSync(tar, 'not-a-real-tar');
      expect(tryLoadSnapshot(tar)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('hash mismatch in .version returns null', () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'snap-stale-'));
    try {
      const tar = joinPath(dir, 'snap.tar');
      writeFileSync(tar, 'not-a-real-tar');
      writeFileSync(joinPath(dir, 'snap.version'), 'deadbeef-not-the-current-hash\n');
      expect(tryLoadSnapshot(tar)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
