/**
 * Self-test for scripts/check-path-sep-boundary.sh — the guard against testing a
 * FILESYSTEM directory boundary with a hardcoded `'/'`.
 *
 * `child.startsWith(parent + '/')` can never match on Windows, where resolve()
 * and realpathSync() emit `\`, and it is an identity transform on POSIX — so
 * gbrain's 100%-ubuntu CI stayed green across 15 broken call sites and four
 * independent reintroductions (sync ×3, archive-crawler ×1). The guard is the
 * backstop; this pins the guard.
 *
 * Fixtures are written to a temp dir and the script is pointed at it via argv,
 * so this never scans the real tree. Fixture *content* deliberately contains the
 * banned idiom; the `path-sep-guard-ok` markers sit in trailing comments on the
 * writeFileSync lines so the guard doesn't flag this file when it scans the repo.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(import.meta.dir, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-path-sep-boundary.sh');

let root: string;
let badDir: string;
let goodDir: string;

// Generous: each case shells out to bash + find + grep + awk, and process spawn
// on Windows costs far more than the scan itself.
const SPAWN_TIMEOUT_MS = 60000;

function runGuard(dir: string): { code: number; out: string } {
  const res = Bun.spawnSync(['bash', SCRIPT, dir], { cwd: REPO_ROOT });
  return { code: res.exitCode, out: res.stdout.toString() + res.stderr.toString() };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'path-sep-guard-'));
  badDir = join(root, 'bad');
  goodDir = join(root, 'good');
  mkdirSync(badDir, { recursive: true });
  mkdirSync(goodDir, { recursive: true });

  // BAD 1: the LocalStorage.contained() shape (fail-CLOSED — dead feature).
  writeFileSync(join(badDir, 'bad_storage.ts'), "const full = resolve(base, p);\nif (!full.startsWith(canonicalBase + '/')) throw new Error('x');\n"); // path-sep-guard-ok
  // BAD 2: the sync.ts:1120 isPathSafe shape — realpath on both sides.
  writeFileSync(join(badDir, 'bad_realpath.ts'), "const real = realpathSync(f);\nconst rootReal = realpathSync(g);\nexport const ok = real === rootReal || real.startsWith(rootReal + '/');\n"); // path-sep-guard-ok
  // BAD 3: the sources-ops overlap shape (fail-OPEN — the dangerous direction).
  writeFileSync(join(badDir, 'bad_overlap.ts'), "export const overlaps = (aPath: string, bPath: string) => aPath.startsWith(bPath + '/') || bPath.startsWith(aPath + '/');\n"); // path-sep-guard-ok
  // BAD 4: two-step, where the separator is bound to a variable first — the
  // real sync.ts:3620 `scopePrefix` shape, invisible to a naive one-line grep.
  writeFileSync(join(badDir, 'bad_twostep.ts'), "const scopePrefix = resolve(gitRoot, sub) + '/';\nexport const inScope = (p: string) => p.startsWith(scopePrefix);\n"); // path-sep-guard-ok
  // BAD 5: two-step via a path-ish identifier rather than a call.
  writeFileSync(join(badDir, 'bad_twostep_ident.ts'), "const prefix = archiveDirAbs + '/';\nexport const under = (p: string) => p.startsWith(prefix);\n"); // path-sep-guard-ok
  // BAD 6: double-quoted spelling.
  writeFileSync(join(badDir, 'bad_dquote.ts'), 'export const x = resolvedFull.startsWith(resolvedRoot + "/");\n'); // path-sep-guard-ok

  // GOOD 1: the fix.
  writeFileSync(
    join(goodDir, 'good_fixed.ts'),
    "import { isPathInside } from '../src/core/path-confine.ts';\nexport const x = isPathInside(full, canonicalBase);\n",
  );
  // GOOD 2: gbrain slugs — forward-slash on every platform, `sep` would be WRONG.
  writeFileSync(
    join(goodDir, 'good_slug.ts'),
    'export function m(slug: string, base: string) {\n  // path-sep-guard-ok: slugs are forward-slash by definition\n  return slug.startsWith(base + "/");\n}\n',
  );
  // GOOD 3: git-relative paths, marker in the comment block ABOVE the
  // expression (the multi-line arrow-function style this codebase uses).
  writeFileSync(
    join(goodDir, 'good_gitrel.ts'),
    '// path-sep-guard-ok: git-relative POSIX paths on both sides — git always\n// emits forward slashes, so a native sep here would be the bug.\nconst inScope = (p: string): boolean =>\n  !scoped || p === relPath || p.startsWith(relPath + \'/\');\n',
  );
  // GOOD 4: template-literal slug form (backlinks.ts / integrity.ts shape).
  writeFileSync(join(goodDir, 'good_template.ts'), 'export const y = slug.startsWith(`${typeFilter}/`);\n');
  // GOOD 5: the banned idiom inside comments — including the doc that describes
  // the rule — must not fire.
  writeFileSync(
    join(goodDir, 'good_comments.ts'),
    "/**\n * Never write child.startsWith(parentPath + '/') — use isPathInside().\n */\n// const bad = full.startsWith(rootPath + '/');\nexport const z = 1;\n",
  );
  // GOOD 6: a non-path string prefix test is not this bug.
  writeFileSync(join(goodDir, 'good_nonpath.ts'), "export const w = mimeType.startsWith(prefixKind + '/');\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-path-sep-boundary guard', () => {
  test('flags every hardcoded-separator boundary shape', () => {
    const { code, out } = runGuard(badDir);
    expect(code).toBe(1);
    for (const f of [
      'bad_storage.ts',
      'bad_realpath.ts',
      'bad_overlap.ts',
      'bad_twostep.ts',
      'bad_twostep_ident.ts',
      'bad_dquote.ts',
    ]) {
      expect(out).toContain(f);
    }
    // The message has to name the fix, not just the sin.
    expect(out).toContain('isPathInside');
    expect(out).toContain('path-confine');
  }, SPAWN_TIMEOUT_MS);

  test('does not flag slugs, git-relative paths, comments, or opt-outs', () => {
    const { code, out } = runGuard(goodDir);
    expect(code).toBe(0);
    expect(out).toContain('ok');
  }, SPAWN_TIMEOUT_MS);

  test('is wired into `bun run verify` and check:all', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['check:path-sep']).toContain('check-path-sep-boundary.sh');
    // Must go through `bash` — bun cannot exec a .sh via its shebang on Windows.
    expect(pkg.scripts['check:path-sep']).toStartWith('bash ');
    expect(pkg.scripts['check:all']).toContain('check-path-sep-boundary.sh');

    // Authoritative over grepping the dispatcher body (which would pass on a
    // commented-out entry).
    const r = Bun.spawnSync(['bash', join(REPO_ROOT, 'scripts', 'run-verify-parallel.sh'), '--dry-list'], {
      cwd: REPO_ROOT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim().split('\n')).toContain('check:path-sep');
  }, SPAWN_TIMEOUT_MS);
});
