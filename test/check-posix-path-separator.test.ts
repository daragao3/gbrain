/**
 * Self-test for scripts/check-posix-path-separator.sh — the guard against
 * comparing a NATIVE filesystem path to a hardcoded '/' literal.
 *
 * path.join()/resolve()/realpathSync() emit the PLATFORM separator, so
 * `child.startsWith(parent + '/')` is permanently false on win32 — fail-closed
 * (every legitimate path rejected) or fail-open (the boundary never fires),
 * depending on how the caller reads it. Every flagged shape is an identity
 * transform on POSIX, so ubuntu-only CI can never surface it. That is why the
 * guard exists; this pins the guard.
 *
 * Fixtures are written to a temp dir and the script is pointed at it via argv,
 * so this never scans the real tree. Fixture literals are assembled from
 * fragments (`SL` below) rather than written out verbatim, so that this test
 * file does not itself trip the guard when it scans the repo — the same reason
 * the sibling url-pathname test carries inline opt-out markers.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(import.meta.dir, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-posix-path-separator.sh');

/** A single-quoted forward slash, kept out of this file's source verbatim. */
const SL = "'" + String.fromCharCode(47) + "'";

let root: string;
let badDir: string;
let goodDir: string;

// Generous per-test timeouts: each case shells out to bash + find + grep +
// awk, and process spawn on Windows costs orders of magnitude more than the
// scan itself (the fixture dirs hold a handful of one-line files).
const SPAWN_TIMEOUT_MS = 60000;

function runGuard(dir: string): { code: number; out: string } {
  const res = Bun.spawnSync(['bash', SCRIPT, dir], { cwd: REPO_ROOT });
  return { code: res.exitCode, out: res.stdout.toString() + res.stderr.toString() };
}

function runTrackedGuard(dir: string): { code: number; out: string } {
  const res = Bun.spawnSync(['bash', SCRIPT], { cwd: dir });
  return { code: res.exitCode, out: res.stdout.toString() + res.stderr.toString() };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'posix-path-sep-guard-'));
  badDir = join(root, 'bad');
  goodDir = join(root, 'good');
  mkdirSync(badDir, { recursive: true });
  mkdirSync(goodDir, { recursive: true });

  // BAD 1: absoluteness test — the test/mounts-cli.test.ts shape.
  writeFileSync(join(badDir, 'bad_absolute.ts'), `if (p.startsWith(${SL})) throw new Error('abs');\n`);
  // BAD 2: containment — the src/core/storage/local.ts shape (fail-closed).
  writeFileSync(
    join(badDir, 'bad_containment.ts'),
    `if (!full.startsWith(base + ${SL}) && full !== base) throw new Error('escape');\n`,
  );
  // BAD 3: containment via a member expression, not a bare identifier.
  writeFileSync(
    join(badDir, 'bad_member.ts'),
    `const ok = abs.startsWith(this.canonicalBase + ${SL});\n`,
  );
  // BAD 4: the parent expression itself contains a call. A `[^)]*` scanner
  // stops at resolve(root)'s close-paren and silently misses the slash suffix.
  writeFileSync(
    join(badDir, 'bad_nested_expr.ts'),
    `const ok = abs.startsWith(resolve(root) + ${SL});\n`,
  );
  // BAD 5: formatter-split call arguments.
  writeFileSync(
    join(badDir, 'bad_multiline_arg.ts'),
    `const ok = abs.startsWith(\n  parent + ${SL}\n);\n`,
  );
  // BAD 6: hand-rolled dirname — the test/migrations-v0_11_0.test.ts shape.
  writeFileSync(
    join(badDir, 'bad_dirname.ts'),
    `const dir = p.substring(0, p.lastIndexOf(${SL}));\n`,
  );
  // BAD 5: same dirname defect spelled with slice().
  writeFileSync(join(badDir, 'bad_dirname_slice.ts'), `const d = p.slice(0, p.lastIndexOf(${SL}));\n`);
  // BAD 6: the call continued onto its own line by the formatter.
  writeFileSync(
    join(badDir, 'bad_continuation.ts'),
    `const inside = resolvedChild\n  .startsWith(resolvedParent + ${SL});\n`,
  );
  // BAD 7: "ensure trailing separator" — the separator smuggled through a
  // variable, which shape 2 alone cannot see. Both path-confine.ts and
  // skillpack/copy.ts independently grew this exact spelling.
  writeFileSync(
    join(badDir, 'bad_trailing_sep.ts'),
    `const prefix = root.endsWith(${SL}) ? root : root + ${SL};\n`,
  );
  // BAD 8: the same ternary split by the formatter.
  writeFileSync(
    join(badDir, 'bad_trailing_sep_multiline.ts'),
    `const prefix = root.endsWith(${SL})\n  ? root\n  : root + ${SL};\n`,
  );

  // GOOD: the two correct replacements.
  writeFileSync(
    join(goodDir, 'good_fixed.ts'),
    'if (!isPathWithin(full, base)) throw new Error("escape");\nconst dir = dirname(p);\nconst abs = isAbsolute(p);\n',
  );
  // GOOD: the BASENAME form — used only on slugs in this repo, and correct
  // there on every platform. Must NOT be confused with the dirname form.
  writeFileSync(join(goodDir, 'good_basename.ts'), `const tail = slug.slice(slug.lastIndexOf(${SL}) + 1);\n`);
  // GOOD: a startsWith with no slash literal at all.
  writeFileSync(join(goodDir, 'good_plain.ts'), "const isDraft = title.startsWith('draft');\n");
  // GOOD: the banned form inside comments — including prose documenting the
  // rule — must not fire.
  writeFileSync(
    join(goodDir, 'good_comments.ts'),
    `/**\n * Never write child.startsWith(parent + ${SL}) — use isPathWithin().\n */\n// const bad = p.startsWith(${SL});\nexport const x = 1;\n`,
  );
  // GOOD: opt-out marker on the same line (the slug case).
  writeFileSync(
    join(goodDir, 'good_optout_inline.ts'),
    `if (slug.startsWith(base + ${SL})) return true; // posix-path-guard-ok: slug\n`,
  );
  // GOOD: marker text in a string is NOT an opt-out for the following line.
  // This belongs in badDir because the next statement must still be reported.
  writeFileSync(
    join(badDir, 'bad_fake_optout.ts'),
    `const marker = 'posix-path-guard-ok';\nconst ok = abs.startsWith(parent + ${SL});\n`,
  );
  // GOOD: comment-looking text inside a string must not erase real code later
  // on the same line.
  writeFileSync(
    join(badDir, 'bad_comment_string.ts'),
    `const marker = '/*'; const ok = abs.startsWith(parent + ${SL});\n`,
  );
  // GOOD: opt-out marker in a comment ABOVE the code, which is where a
  // multi-line rationale reads best (the src/core/markdown.ts shape).
  writeFileSync(
    join(goodDir, 'good_optout_above.ts'),
    `// posix-path-guard-ok: git-diff output is git-root-relative and always\n// '/'-separated on every platform.\nconst inScope = p.startsWith(scopeRel + ${SL});\n`,
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-posix-path-separator guard', () => {
  test('flags every native-path-vs-slash shape', () => {
    const { code, out } = runGuard(badDir);
    expect(code).toBe(1);
    for (const f of [
      'bad_absolute.ts',
      'bad_containment.ts',
      'bad_member.ts',
      'bad_nested_expr.ts',
      'bad_multiline_arg.ts',
      'bad_fake_optout.ts',
      'bad_comment_string.ts',
      'bad_dirname.ts',
      'bad_dirname_slice.ts',
      'bad_continuation.ts',
      'bad_trailing_sep.ts',
      'bad_trailing_sep_multiline.ts',
    ]) {
      expect(out).toContain(f);
    }
    // The message has to name the fix, not just the sin.
    expect(out).toContain('isPathWithin');
    expect(out).toContain('isAbsolute');
    expect(out).toContain('dirname');
  }, SPAWN_TIMEOUT_MS);

  test('does not flag slugs, basenames, comments, or opt-outs', () => {
    const { code, out } = runGuard(goodDir);
    expect(code).toBe(0);
    expect(out).toContain('ok');
  }, SPAWN_TIMEOUT_MS);

  test.if(process.platform !== 'win32')('keeps newline-bearing candidate filenames intact', () => {
    const newlineDir = join(root, 'newline');
    mkdirSync(newlineDir, { recursive: true });
    const filename = `bad_newline\ncontainment.ts`;
    writeFileSync(
      join(newlineDir, filename),
      `const ok = abs.startsWith(parent + ${SL});\n`,
    );

    const { code, out } = runGuard(newlineDir);
    expect(code).toBe(1);
    expect(out).toContain(filename);
  }, SPAWN_TIMEOUT_MS);

  test.if(process.platform !== 'win32' && Bun.which('git') !== null)(
    'keeps tracked newline-bearing candidate filenames intact',
    () => {
      const repoDir = join(root, 'newline-repo');
      mkdirSync(repoDir, { recursive: true });
      const filename = `bad_tracked_newline\ncontainment.ts`;
      writeFileSync(
        join(repoDir, filename),
        `const ok = abs.startsWith(parent + ${SL});\n`,
      );
      expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: repoDir }).exitCode).toBe(0);
      expect(Bun.spawnSync(['git', 'add', '--', filename], { cwd: repoDir }).exitCode).toBe(0);

      const { code, out } = runTrackedGuard(repoDir);
      expect(code).toBe(1);
      expect(out).toContain(filename);
    },
    SPAWN_TIMEOUT_MS,
  );

  test('is wired into `bun run verify` and check:all', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['check:posix-path-sep']).toContain('check-posix-path-separator.sh');
    // package.json must invoke it through `bash` — bun cannot exec a .sh via
    // its shebang on Windows.
    expect(pkg.scripts['check:posix-path-sep']).toStartWith('bash ');
    expect(pkg.scripts['check:all']).toContain('check-posix-path-separator.sh');

    // Authoritative over grepping the dispatcher body (which would pass on a
    // commented-out entry).
    const r = Bun.spawnSync(['bash', join(REPO_ROOT, 'scripts', 'run-verify-parallel.sh'), '--dry-list'], {
      cwd: REPO_ROOT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim().split('\n')).toContain('check:posix-path-sep');
  }, SPAWN_TIMEOUT_MS);
});
