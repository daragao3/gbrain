/**
 * Self-test for scripts/check-frontmatter-fence.sh — the guard against an
 * LF-only YAML frontmatter fence (`/^---\n/` instead of `/^---\r?\n/`).
 *
 * With no `m` flag, `^` anchors at offset 0 only, so a CRLF file matches
 * NOWHERE and the parser returns null/[] silently. On Windows
 * `core.autocrlf=true` makes every checked-out SKILL.md CRLF, so it fires for
 * the whole skills tree at once; and it is an identity transform on POSIX, so
 * gbrain's ubuntu-only CI can never surface it. That combination is why the
 * defect recurred six times. The guard is the backstop; this pins the guard.
 *
 * Fixtures are written to a temp dir and the script is pointed at it via argv,
 * so this never scans the real tree. The fixture literals below carry a
 * `frontmatter-fence-guard-ok` marker so the guard doesn't flag its own test
 * file when it scans test/; the marker lives in a trailing comment, never
 * inside the fixture content itself.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(import.meta.dir, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-frontmatter-fence.sh');

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

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'frontmatter-fence-guard-'));
  badDir = join(root, 'bad');
  goodDir = join(root, 'good');
  mkdirSync(badDir, { recursive: true });
  mkdirSync(goodDir, { recursive: true });

  // BAD 1: the canonical recurrence — LF-only fence in a .match().
  writeFileSync(join(badDir, 'bad_match.ts'), 'const m = c.match(/^---\\n([\\s\\S]*?)\\n---/);\n'); // frontmatter-fence-guard-ok
  // BAD 2: module-level const regex (the skill-brain-first.ts shape).
  writeFileSync(join(badDir, 'bad_const_re.ts'), 'const FM_RE = /^---\\n[\\s\\S]*?\\n---\\n?/;\n'); // frontmatter-fence-guard-ok
  // BAD 3: the method form.
  writeFileSync(join(badDir, 'bad_startswith.ts'), "if (body.startsWith('---\\n')) { strip(); }\n"); // frontmatter-fence-guard-ok
  // BAD 4: startsWith with double quotes (the skills-conformance.test.ts shape).
  writeFileSync(join(badDir, 'bad_startswith_dq.ts'), 'expect(c.startsWith("---\\n")).toBe(true);\n'); // frontmatter-fence-guard-ok
  // BAD 5: LF-only fence used to STRIP frontmatter — silent no-op on CRLF.
  writeFileSync(join(badDir, 'bad_strip.ts'), 'const body = c.replace(/^---\\n[\\s\\S]*?\\n---\\n/, "");\n'); // frontmatter-fence-guard-ok
  // BAD 6: a normalize too far above to plausibly cover the fence. Pins that
  // the NORMWIN window is bounded — otherwise any `\r\n` replace anywhere in a
  // file would launder every LF-only fence below it.
  writeFileSync(
    join(badDir, 'bad_normalize_too_far.ts'),
    'const n = c.replace(/\\r\\n/g, "\\n");\n' +
      'const a = 1;\nconst b = 2;\nconst d = 3;\nconst e = 4;\n' +
      'const f = 5;\nconst g = 6;\nconst h = 7;\nconst i = 8;\nconst j = 9;\n' +
      'const m = other.match(/^---\\n([\\s\\S]*?)\\n---/);\n', // frontmatter-fence-guard-ok
  );

  // GOOD 1: the canonical CRLF-tolerant fence (src/core/skill-frontmatter.ts).
  writeFileSync(join(goodDir, 'good_tolerant.ts'), 'const m = c.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/);\n');
  // GOOD 2: normalize-first, then an LF fence (check-resolvable / skill-manifest
  // / skillpack shape). The preceding normalize is what satisfies the guard.
  writeFileSync(
    join(goodDir, 'good_normalized.ts'),
    'const n = c.replace(/\\r\\n/g, "\\n");\nconst m = n.match(/^---\\n([\\s\\S]*?)\\n---/);\n',
  );
  // GOOD 3: the relaxed fence that must NOT be normalized, because its result is
  // a byte offset into the original text (skillopt/apply-edits.ts splitFrontmatter).
  writeFileSync(join(goodDir, 'good_offset_fence.ts'), 'const m = text.match(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n/);\n');
  // GOOD 4: DATA construction, not parsing. This is the shape the guard must
  // never flag — it accounts for the overwhelming majority of `---\n` in the
  // tree (fixture bodies, page builders, markdown-HR joins).
  writeFileSync(
    join(goodDir, 'good_data.ts'),
    'const page = `---\\n${fm}\\n---\\n\\n# ${title}\\n`;\n' +
      "const fixture = '---\\ntitle: Alice\\n---\\n\\nbody\\n';\n" +
      "const joined = parts.join('\\n\\n---\\n\\n');\n",
  );
  // GOOD 5: the banned form inside comments — including the doc comments that
  // document this very rule — must not fire.
  writeFileSync(
    join(goodDir, 'good_comments.ts'),
    '/**\n * An LF-only fence (`^---\\n`) cannot match a file starting `---\\r\\n`.\n */\n' +
      '// const bad = c.match(/^---\\n/);\nexport const x = 1;\n',
  );
  // GOOD 6: explicit opt-out, trailing the flagged line.
  writeFileSync(
    join(goodDir, 'good_optout_inline.ts'),
    'expect(md).toMatch(/^---\\n/); // frontmatter-fence-guard-ok: asserts our own LF output\n',
  );
  // GOOD 7: explicit opt-out in the comment block ABOVE the flagged line — the
  // form that lets an opt-out carry a real reason.
  writeFileSync(
    join(goodDir, 'good_optout_above.ts'),
    '// frontmatter-fence-guard-ok: asserts gbrain\'s OWN emitted markdown, which\n' +
      '// is built in memory with `\\n`. LF is the property under test here.\n' +
      'expect(md).toMatch(/^---\\n/);\n',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-frontmatter-fence guard', () => {
  test('flags every LF-only frontmatter fence shape', () => {
    const { code, out } = runGuard(badDir);
    expect(code).toBe(1);
    for (const f of [
      'bad_match.ts',
      'bad_const_re.ts',
      'bad_startswith.ts',
      'bad_startswith_dq.ts',
      'bad_strip.ts',
      'bad_normalize_too_far.ts',
    ]) {
      expect(out).toContain(f);
    }
    // The message has to name both fixes, not just the sin.
    expect(out).toContain('\\r?\\n');
    expect(out).toContain("replace(/\\r\\n/g, '\\n')");
  }, SPAWN_TIMEOUT_MS);

  test('does not flag tolerant fences, normalize-first, data, comments, or opt-outs', () => {
    const { code, out } = runGuard(goodDir);
    expect(code).toBe(0);
    expect(out).toContain('ok');
  }, SPAWN_TIMEOUT_MS);

  test('the real src/ and test/ tree is clean', () => {
    // The guard's whole point is that CI cannot catch this class, so the
    // in-tree scan is asserted here rather than left to a green Linux run.
    const res = Bun.spawnSync(['bash', SCRIPT], { cwd: REPO_ROOT });
    const out = res.stdout.toString() + res.stderr.toString();
    expect(out).not.toContain('LF-only YAML frontmatter fence');
    expect(res.exitCode).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  test('is wired into `bun run verify` and check:all', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['check:frontmatter-fence']).toContain('check-frontmatter-fence.sh');
    // package.json must invoke it through `bash` — bun cannot exec a .sh via
    // its shebang on Windows.
    expect(pkg.scripts['check:frontmatter-fence']).toStartWith('bash ');
    expect(pkg.scripts['check:all']).toContain('check-frontmatter-fence.sh');

    // Authoritative over grepping the dispatcher body (which would pass on a
    // commented-out entry).
    const r = Bun.spawnSync(['bash', join(REPO_ROOT, 'scripts', 'run-verify-parallel.sh'), '--dry-list'], {
      cwd: REPO_ROOT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim().split('\n')).toContain('check:frontmatter-fence');
  }, SPAWN_TIMEOUT_MS);
});
