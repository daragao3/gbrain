import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from './helpers/repo-root.ts';

// scripts/ci-worktree-mounts.sh computes the docker-run arguments that make
// `git` work inside the ci:local runner when the checkout is a linked worktree.
// Its two failure modes are Windows-only identity-transform traps: on
// macOS/Linux the host and container path forms coincide, so a real CI run can
// never catch them. `uname` and `cygpath` are stubbed on PATH so both platform
// branches are exercised from any host.

const HELPER = repoPath('scripts', 'ci-worktree-mounts.sh').replaceAll('\\', '/');
const BASH = process.platform === 'win32'
  ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';

interface HelperResult {
  rc: number;
  args: string[];
  pathconv: string;
  pointerFile: string | null;
  stderr: string;
}

interface HelperOptions {
  uname: string;
  brokenCygpath?: boolean;
  gitKind?: 'worktree' | 'directory';
}

// Spawning Git-Bash costs ~15s on a contended Windows host; each distinct
// configuration is spawned once and shared by the assertions that read it.
const helperCache = new Map<string, HelperResult>();
function runHelper(options: HelperOptions): HelperResult {
  const key = JSON.stringify(options);
  let cached = helperCache.get(key);
  if (!cached) {
    cached = runHelperUncached(options);
    helperCache.set(key, cached);
  }
  return cached;
}

function runHelperUncached(options: HelperOptions): HelperResult {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-ci-worktree-mounts-')).replaceAll('\\', '/');
  const commonGitdir = `${root}/canonical/.git`;
  const worktreeGitdir = `${commonGitdir}/worktrees/wt`;
  const checkout = `${root}/worktrees/wt`;
  const fakeBin = `${root}/fakebin`;

  mkdirSync(worktreeGitdir, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(`${root}/tmp`, { recursive: true });
  writeFileSync(`${worktreeGitdir}/commondir`, '../..\n');

  if ((options.gitKind ?? 'worktree') === 'directory') {
    mkdirSync(`${checkout}/.git`);
  } else {
    writeFileSync(`${checkout}/.git`, `gitdir: ${worktreeGitdir}\n`);
  }

  writeFileSync(`${fakeBin}/uname`, `#!/bin/sh\nprintf '%s\\n' '${options.uname}'\n`);
  chmodSync(`${fakeBin}/uname`, 0o755);
  // The stub always exists: Git-Bash ships a real /usr/bin/cygpath that PATH
  // cannot hide, so an unusable cygpath is simulated by a failing one — the
  // same branch the helper takes when the binary is missing (127).
  writeFileSync(
    `${fakeBin}/cygpath`,
    options.brokenCygpath
      ? '#!/bin/sh\necho "cygpath: unavailable" >&2\nexit 1\n'
      // A real `cygpath -m` rewrites /c/Users/... to C:/Users/...; the marker
      // just has to prove the conversion was applied to the host half.
      : '#!/bin/sh\nprintf \'FAKEWIN:%s\\n\' "$2"\n',
  );
  chmodSync(`${fakeBin}/cygpath`, 0o755);

  const driver = `${root}/driver.sh`;
  writeFileSync(
    driver,
    [
      'set -uo pipefail',
      // Captured to a file: the driver exits 0 even when the helper returns
      // non-zero, so execFileSync never surfaces the child's stderr.
      `exec 2>"${root}/stderr.txt"`,
      // A `C:/...` PATH entry would split on its drive colon under MSYS and the
      // stubs would never be found; re-derive the POSIX form via cd+pwd, which
      // is an identity transform on macOS/Linux.
      `export PATH="$(cd '${fakeBin}' && pwd):$PATH"`,
      `export TMPDIR="$(cd '${root}/tmp' && pwd)"`,
      'unset MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL',
      `source "${HELPER}"`,
      `if gbrain_ci_worktree_mounts "${checkout}" >/dev/null; then rc=0; else rc=$?; fi`,
      'echo "RC=$rc"',
      // `printf fmt` with zero arguments still emits the format once.
      'if [ "${#GBRAIN_CI_EXTRA_MOUNTS[@]}" -gt 0 ]; then',
      '  printf \'ARG:%s\\n\' "${GBRAIN_CI_EXTRA_MOUNTS[@]}"',
      'fi',
      'echo "PATHCONV=${MSYS_NO_PATHCONV:-unset}"',
      '',
    ].join('\n'),
  );

  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(BASH, ['--noprofile', '--norc', driver], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
  }
  if (existsSync(`${root}/stderr.txt`)) stderr += readFileSync(`${root}/stderr.txt`, 'utf8');
  const lines = stdout.split(/\r?\n/);

  // The emitted host path is in the shell's own form (an MSYS /tmp/... path, or
  // the FAKEWIN: marker), neither of which node can open; read the pointer back
  // through the fixture root instead.
  let pointerFile: string | null = null;
  if (lines.some((line) => line.startsWith('ARG:') && line.includes(':/app/.git:ro'))) {
    const [pointerDir] = readdirSync(`${root}/tmp`);
    pointerFile = readFileSync(`${root}/tmp/${pointerDir}/dotgit`, 'utf8');
  }

  return {
    rc: Number(lines.find((line) => line.startsWith('RC='))?.slice(3) ?? -1),
    args: lines.filter((line) => line.startsWith('ARG:')).map((line) => line.slice('ARG:'.length)),
    pathconv: lines.find((line) => line.startsWith('PATHCONV='))?.slice('PATHCONV='.length) ?? '',
    pointerFile,
    stderr,
  };
}

describe('ci-worktree-mounts.sh', () => {
  test('canonical checkout (.git directory) contributes no docker arguments', () => {
    const result = runHelper({ uname: 'Linux', gitKind: 'directory' });
    expect(result.rc).toBe(0);
    expect(result.args).toEqual([]);
  }, 120_000);

  test('worktree mounts the common gitdir at a FIXED container path, never the host path', () => {
    const result = runHelper({ uname: 'Linux' });
    expect(result.rc).toBe(0);
    // Regression: the old code emitted `-v "$COMMON_GITDIR:$COMMON_GITDIR:ro"`,
    // which assumes the host path is also a valid container path.
    const gitdirMount = result.args.find((arg) => arg.endsWith(':/gbrain-gitdir:ro'));
    expect(gitdirMount).toBeDefined();
    const hostHalf = gitdirMount!.replace(/:\/gbrain-gitdir:ro$/, '');
    expect(hostHalf).toContain('/canonical/.git');
    expect(hostHalf).not.toBe('/gbrain-gitdir');
  }, 120_000);

  test('worktree overlays a .git pointer naming the CONTAINER gitdir', () => {
    const result = runHelper({ uname: 'Linux' });
    // Regression: on Windows the repo's own .git file says `gitdir: C:/...`,
    // which git resolves RELATIVE to the cwd -> /app/C:/Users/... The overlay
    // must therefore be an absolute container path under the mount point.
    expect(result.pointerFile).toBe('gitdir: /gbrain-gitdir/worktrees/wt\n');
    expect(result.args).toContain('-v');
    expect(result.args.some((arg) => arg.endsWith(':/app/.git:ro'))).toBe(true);
  }, 120_000);

  test('POSIX hosts leave the host path unconverted and do not touch MSYS argv handling', () => {
    const result = runHelper({ uname: 'Linux' });
    expect(result.args.every((arg) => !arg.includes('FAKEWIN:'))).toBe(true);
    expect(result.pathconv).toBe('unset');
  }, 120_000);

  test('MSYS hosts convert BOTH host halves and disable MSYS argv path conversion', () => {
    const result = runHelper({ uname: 'MINGW64_NT-10.0-26200' });
    expect(result.rc).toBe(0);
    // Docker Desktop cannot resolve an MSYS /c/Users/... host path: it mounts
    // an empty directory instead of failing, so the conversion is load-bearing.
    const hostHalves = result.args
      .filter((arg) => arg !== '-v')
      .map((arg) => arg.replace(/:(\/gbrain-gitdir|\/app\/\.git):ro$/, ''));
    expect(hostHalves).toHaveLength(2);
    expect(hostHalves.filter((half) => !half.startsWith('FAKEWIN:'))).toEqual([]);
    // Container halves stay verbatim POSIX paths.
    expect(result.args.some((arg) => arg.endsWith(':/gbrain-gitdir:ro'))).toBe(true);
    expect(result.args.some((arg) => arg.endsWith(':/app/.git:ro'))).toBe(true);
    expect(result.pathconv).toBe('1');
    expect(result.pointerFile).toBe('gitdir: /gbrain-gitdir/worktrees/wt\n');
  }, 120_000);

  test('MSYS host with an unusable cygpath fails loudly instead of emitting an unresolvable mount', () => {
    const result = runHelper({ uname: 'MINGW64_NT-10.0-26200', brokenCygpath: true });
    expect(result.rc).toBe(2);
    expect(result.args).toEqual([]);
    expect(result.stderr).toContain('cygpath');
  }, 120_000);
});
