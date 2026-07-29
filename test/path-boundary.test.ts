/**
 * Tests for the directory-boundary primitives in src/core/path-confine.ts
 * (`isPathInside` / `isPathStrictlyInside`) and the platform semantics they
 * inherit from `path.relative()`.
 *
 * WHY THIS FILE EXISTS. The idiom these replace — `child.startsWith(parent + '/')`
 * — is an IDENTITY TRANSFORM on POSIX. gbrain's CI is 100% ubuntu-latest, so
 * every one of the 15 broken call sites was green on CI the entire time it was
 * broken on Windows, and the same defect was independently reintroduced four
 * times (sync ×3, archive-crawler ×1). Tests that only assert POSIX behavior
 * therefore prove nothing about the bug. So this file is split three ways:
 *
 *   1. platform-agnostic contract — true on both platforms;
 *   2. win32-only — the separator + NTFS case-folding semantics that are the
 *      whole point of the fix, and which would FAIL against the old idiom;
 *   3. POSIX-only — the complementary guarantee that we did NOT accidentally
 *      make POSIX case-insensitive or treat `\` as a separator there (both
 *      would be fail-OPEN regressions on Linux, the platform CI does cover).
 *
 * The win32 block is what makes the regression detectable at all; it skips on
 * CI by design. `scripts/check-path-sep-boundary.sh` is the static backstop
 * that runs everywhere.
 */

import { describe, it, expect } from 'bun:test';
import { join, resolve, sep } from 'path';
import {
  isPathInside,
  isPathStrictlyInside,
  isPathContained,
} from '../src/core/path-confine.ts';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';

const IS_WIN = process.platform === 'win32';
const describeWin = IS_WIN ? describe : describe.skip;
const describePosix = IS_WIN ? describe.skip : describe;

/** Build a platform-native absolute path from POSIX-looking segments. */
const abs = (...segs: string[]): string => resolve(sep === '\\' ? 'C:\\' : '/', ...segs);

describe('isPathInside — platform-agnostic contract', () => {
  it('a nested file is inside its root', () => {
    expect(isPathInside(abs('repo', 'docs', 'a.md'), abs('repo'))).toBe(true);
  });

  it('a path is inside itself (inclusive)', () => {
    expect(isPathInside(abs('repo'), abs('repo'))).toBe(true);
  });

  it('a deep descendant is inside', () => {
    expect(isPathInside(abs('repo', 'a', 'b', 'c', 'd.md'), abs('repo'))).toBe(true);
  });

  it('an unrelated path is not inside', () => {
    expect(isPathInside(abs('other', 'a.md'), abs('repo'))).toBe(false);
  });

  it('the parent is not inside its own child', () => {
    expect(isPathInside(abs('repo'), abs('repo', 'docs'))).toBe(false);
  });

  it('a sibling sharing a name prefix is NOT inside (/foo vs /foobar)', () => {
    // The classic reason the boundary needs a separator at all.
    expect(isPathInside(abs('repobar', 'a.md'), abs('repo'))).toBe(false);
    expect(isPathInside(abs('repo-2'), abs('repo'))).toBe(false);
  });

  it('an upward traversal escapes', () => {
    expect(isPathInside(join(abs('repo'), '..', 'etc', 'passwd'), abs('repo'))).toBe(false);
  });

  it('a directory literally named "..config" is NOT treated as an escape', () => {
    // Guards the bare `rel.startsWith('..')` spelling, which rejects this.
    expect(isPathInside(abs('repo', '..config', 'x.md'), abs('repo'))).toBe(true);
  });

  it('isPathStrictlyInside excludes the root itself but keeps descendants', () => {
    expect(isPathStrictlyInside(abs('repo'), abs('repo'))).toBe(false);
    expect(isPathStrictlyInside(abs('repo', 'docs'), abs('repo'))).toBe(true);
    expect(isPathStrictlyInside(abs('other'), abs('repo'))).toBe(false);
  });
});

describeWin('isPathInside — win32 semantics (the actual regression)', () => {
  it('matches across a backslash boundary', () => {
    // The old `startsWith(parent + '/')` returned false here — pinning every
    // allow-fence closed and every deny-fence open.
    expect(isPathInside('C:\\repo\\docs\\a.md', 'C:\\repo')).toBe(true);
  });

  it('matches when the two sides disagree on separator style', () => {
    // git emits `C:/repo`; realpathSync/resolve emit `C:\repo`.
    expect(isPathInside('C:\\repo\\docs\\a.md', 'C:/repo')).toBe(true);
    expect(isPathInside('C:/repo/docs/a.md', 'C:\\repo')).toBe(true);
  });

  it('folds case, because NTFS is case-insensitive', () => {
    // A deny-list spelled `Private` must still catch a candidate under
    // `private` — they are the SAME directory. Missing it is fail-OPEN.
    expect(isPathInside('C:\\REPO\\Docs\\a.md', 'C:\\repo')).toBe(true);
    expect(isPathInside('C:\\repo\\writing\\private\\tax.md', 'C:\\repo\\Writing\\Private')).toBe(true);
  });

  it('still enforces the boundary under case folding', () => {
    expect(isPathInside('C:\\REPOBAR\\a.md', 'C:\\repo')).toBe(false);
  });

  it('treats a different drive as outside', () => {
    // path.relative across volumes returns an absolute path, not a `..` chain.
    expect(isPathInside('D:\\repo\\a.md', 'C:\\repo')).toBe(false);
  });
});

describePosix('isPathInside — POSIX semantics (must NOT inherit win32 folding)', () => {
  it('stays case-SENSITIVE', () => {
    // Folding here would collide two genuinely different directories → fail-open.
    expect(isPathInside('/repo/docs/a.md', '/repo')).toBe(true);
    expect(isPathInside('/REPO/docs/a.md', '/repo')).toBe(false);
  });

  it('treats a backslash as an ordinary filename character, not a separator', () => {
    // `a\b` is a single legal filename on POSIX.
    expect(isPathInside('/repo/a\\b', '/repo')).toBe(true);
    expect(isPathInside('/repo\\evil', '/repo')).toBe(false);
  });

  it('is byte-identical to the pre-fix idiom for the ordinary cases', () => {
    // The fix must be a no-op on the platform CI actually runs, so this pins
    // the equivalence rather than trusting the reasoning.
    const cases: Array<[string, string]> = [
      ['/repo/docs/a.md', '/repo'],
      ['/repo', '/repo'],
      ['/repobar/a.md', '/repo'],
      ['/other/a.md', '/repo'],
      ['/repo/a/b/c', '/repo'],
    ];
    for (const [child, parent] of cases) {
      const legacy = child === parent || child.startsWith(parent + '/');
      expect(isPathInside(child, parent)).toBe(legacy);
    }
  });
});

describe('isPathContained — symlink-safe wrapper delegates to the same boundary', () => {
  it('contains a real nested file and rejects an outside one', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-boundary-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'gb-outside-')));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), '# a');
    writeFileSync(join(outside, 'b.md'), '# b');

    expect(isPathContained(join(root, 'docs', 'a.md'), root)).toBe(true);
    expect(isPathContained(root, root)).toBe(true);
    expect(isPathContained(join(outside, 'b.md'), root)).toBe(false);
  });

  it('fails closed on an unresolvable path', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-boundary-')));
    expect(isPathContained(join(root, 'does-not-exist.md'), root)).toBe(false);
  });
});
