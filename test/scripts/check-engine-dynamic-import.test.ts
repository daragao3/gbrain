import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const GUARD = resolve(REPO_ROOT, 'scripts', 'check-engine-dynamic-import.sh');
const VERIFY_DISPATCHER = resolve(REPO_ROOT, 'scripts', 'run-verify-parallel.sh');
const BASH = process.platform === 'win32'
  ? resolve(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';
const tempDirs: string[] = [];

function fixture(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-engine-import-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function runGuard(files: string[] = []) {
  const result = spawnSync(BASH, [GUARD, ...files], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-engine-dynamic-import.sh', () => {
  it('exists', () => {
    expect(existsSync(GUARD)).toBe(true);
  });

  it('rejects and reports an unmarked dynamic import', () => {
    const path = fixture('violator.ts', "async function load() {\n  return await import('./helper.ts');\n}\n");
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:2:`);
    expect(result.stderr).toContain("await import('./helper.ts')");
  });

  it('allows a same-line marker and ignores comment-only matches', () => {
    const path = fixture(
      'allowed.ts',
      [
        "// await import('./comment.ts')",
        "/* await import('./block-open.ts') */",
        " * await import('./block-body.ts')",
        "const gateway = await import('./ai/gateway.ts'); // engine-dynamic-import-ok",
        '',
      ].join('\n'),
    );
    const result = runGuard([path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('check-engine-dynamic-import: ok (1 file(s) scanned)');
  });

  it('still catches a violation in CRLF input', () => {
    const path = fixture('crlf.ts', "async function load() {\r\n  return await import('./helper.ts');\r\n}\r\n");
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:2:`);
  });

  it('passes on the reconciled repository sources', () => {
    const result = runGuard();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('check-engine-dynamic-import: ok (3 file(s) scanned)');
  });
});
