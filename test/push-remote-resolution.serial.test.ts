/**
 * Push-remote resolution — the fork-shape defect (never assume `origin`).
 *
 * These tests drive REAL git against REAL local bare repos. A regression must
 * show up as a branch landing in the WRONG bare repo (an observable, on-disk
 * fact), not as a mocked argv assertion — a mock would happily agree with a
 * push that went to the upstream project.
 *
 * The shape under test: `origin` is the UPSTREAM project and the operator's own
 * fork is a differently-named remote. gbrain reaches such repos via
 * `gbrain sources harden` (which hardens ANY source row with a local_path,
 * including `--path`-registered trees gbrain never cloned) and via
 * `gbrain skillpack endorse --repo <dir>` (default: CWD).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// This box spawns git slowly (~0.5s/invocation under Defender); every test here
// drives real git against real bare repos, so the 5s bun default is far too tight.
const T = 120_000;
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

import { resolvePushRemote, pushProbe } from '../src/core/git-remote.ts';
import { runEndorse, EndorseError } from '../src/core/skillpack/endorse.ts';
import { REGISTRY_SCHEMA_VERSION } from '../src/core/skillpack/registry-schema.ts';

// The bare "remotes" here are local paths, so gbrain's SSRF flag set
// (protocol.file.allow=never) would reject them. This is the documented escape
// hatch for exactly that — see durableSsrfFlags in src/core/git-remote.ts.
process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}
/** `git config --unset-all` exits 5 when the key is already absent. */
function unset(cwd: string, key: string): void {
  try { git(cwd, 'config', '--unset-all', key); } catch { /* already unset */ }
}
function initBare(path: string): string {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path], { stdio: 'ignore' });
  return path;
}
/** SHA of <branch> in a bare repo, or '' when the ref does not exist. */
function bareHead(bare: string, branch = 'main'): string {
  try { return git(bare, 'rev-parse', `refs/heads/${branch}`); } catch { return ''; }
}

let root: string;
/** origin = the UPSTREAM project (NOT ours). */
let upstreamBare: string;
/** fork = the operator's own repo (where pushes SHOULD land). */
let forkBare: string;
let work: string;

/**
 * A fork-shaped checkout: cloned from upstream (so origin = upstream), with the
 * operator's fork added as a second remote. Exactly the shape of
 * C:\Users\diego\gbrain itself.
 */
function makeForkShapedRepo(opts: { forkRemoteName?: string } = {}): void {
  const forkName = opts.forkRemoteName ?? 'fork';
  upstreamBare = initBare(mkdtempSync(join(root, 'upstream-')) + '.git');
  forkBare = initBare(mkdtempSync(join(root, 'fork-')) + '.git');
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', upstreamBare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  git(work, 'config', 'protocol.file.allow', 'always');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'remote', 'add', forkName, forkBare);
  git(work, 'fetch', '-q', forkName);
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gb-pushremote-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows */ } });

describe('resolvePushRemote', () => {
  test('branch.<b>.pushRemote wins over everything else', () => {
    makeForkShapedRepo();
    git(work, 'config', 'branch.main.pushRemote', 'fork');
    const res = resolvePushRemote(work, 'main');
    expect(res).toEqual({ ok: true, remote: 'fork', via: 'branch.pushRemote' });
  }, T);

  test('remote.pushDefault is honoured when no branch pushRemote is set', () => {
    makeForkShapedRepo();
    git(work, 'config', 'remote.pushDefault', 'fork');
    const res = resolvePushRemote(work, 'main');
    expect(res).toEqual({ ok: true, remote: 'fork', via: 'remote.pushDefault' });
  }, T);

  test('branch.<b>.remote is used when neither push key is set', () => {
    makeForkShapedRepo();
    // clone set branch.main.remote=origin; point it at the fork instead
    git(work, 'config', 'branch.main.remote', 'fork');
    const res = resolvePushRemote(work, 'main');
    expect(res).toEqual({ ok: true, remote: 'fork', via: 'branch.remote' });
  }, T);

  test('falls back to a trunk branch remote for a topic branch with no config', () => {
    makeForkShapedRepo();
    git(work, 'config', 'branch.main.remote', 'fork');
    git(work, 'checkout', '-q', '-b', 'topic');
    const res = resolvePushRemote(work, 'topic');
    expect(res).toEqual({ ok: true, remote: 'fork', via: 'trunk.remote' });
  }, T);

  test('a lone remote is used even with no branch config at all', () => {
    makeForkShapedRepo();
    git(work, 'remote', 'remove', 'origin');
    unset(work, 'branch.main.remote');
    const res = resolvePushRemote(work, 'main');
    expect(res).toEqual({ ok: true, remote: 'fork', via: 'sole-remote' });
  }, T);

  test('REFUSES rather than falling back to origin when nothing resolves', () => {
    makeForkShapedRepo();
    // Two remotes, zero configuration → genuinely ambiguous.
    unset(work, 'branch.main.remote');
    git(work, 'checkout', '-q', '-b', 'topic');
    const res = resolvePushRemote(work, 'topic');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    // The whole point: an ambiguous repo must NOT silently become `origin`.
    expect(res.reason).toContain('cannot resolve a push remote');
    expect(res.reason).toContain('fork');
  }, T);

  test('refuses a config value that is a URL rather than a configured remote', () => {
    // git accepts a URL where a remote name belongs, so an unvalidated config
    // read is an arbitrary push destination. Proven live, not theorised: the
    // push below really would have reached `strangerBare`.
    makeForkShapedRepo();
    const strangerBare = initBare(mkdtempSync(join(root, 'stranger-')) + '.git');
    git(work, 'config', 'remote.pushDefault', strangerBare);

    const res = resolvePushRemote(work, 'main');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('is not a configured remote');

    // Falsifier: git itself would have accepted that URL as a push target.
    expect(bareHead(strangerBare)).toBe('');
    git(work, 'push', '-q', strangerBare, 'HEAD:main');
    expect(bareHead(strangerBare)).toBe(git(work, 'rev-parse', 'HEAD'));
  }, T);

  test('a set-but-unknown remote name is a hard refusal, not a fall-through', () => {
    makeForkShapedRepo();
    git(work, 'config', 'branch.main.pushRemote', 'typo-remote');
    git(work, 'config', 'branch.main.remote', 'fork'); // a lower rule WOULD have matched
    const res = resolvePushRemote(work, 'main');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('typo-remote');
  }, T);

  test('no remotes at all → refuse', () => {
    const solo = mkdtempSync(join(root, 'solo-'));
    execFileSync('git', ['init', '-q', '-b', 'main', solo], { stdio: 'ignore' });
    const res = resolvePushRemote(solo, 'main');
    expect(res.ok).toBe(false);
  }, T);
});

describe('pushProbe targets the resolved remote', () => {
  test('probes the fork, not origin', () => {
    makeForkShapedRepo();
    git(work, 'config', 'branch.main.pushRemote', 'fork');
    git(work, 'config', 'protocol.file.allow', 'always');
    const res = pushProbe(work, 'main');
    expect(res).toEqual({ ok: true, remote: 'fork' });
  }, T);

  test('reports no-remote instead of silently probing origin', () => {
    makeForkShapedRepo();
    unset(work, 'branch.main.remote');
    git(work, 'checkout', '-q', '-b', 'topic');
    const res = pushProbe(work, 'topic');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('no-remote');
  }, T);
});

describe('skillpack endorse --push lands in the operator fork, not upstream', () => {
  function makeRegistry(): void {
    makeForkShapedRepo();
    writeFileSync(join(work, 'registry.json'), JSON.stringify({
      schema_version: REGISTRY_SCHEMA_VERSION,
      updated_at: '2026-08-12T00:00:00Z',
      skillpacks: [{
        name: 'demo-pack',
        description: 'fixture pack',
        author: 'Tester',
        author_handle: 'tester',
        homepage: 'https://example.invalid/demo-pack',
        source: { kind: 'git', url: 'https://example.invalid/demo-pack.git', pinned_commit: 'abcdef1' },
        tarball_sha256: 'a'.repeat(64),
        gbrain_min_version: '0.42.0',
        default_tier: 'community',
        tags: ['fixture'],
        validated_at: '2026-08-12T00:00:00Z',
        validation_run_id: 'fixture-run-1',
        skills_count: 1,
        skills: ['demo-skill'],
        version: '1.0.0',
      }],
    }, null, 2) + '\n');
    git(work, 'add', 'registry.json');
    git(work, 'commit', '-qm', 'registry');
    git(work, 'push', '-q', 'origin', 'main');
  }

  test('pushes to the configured push remote — upstream is left untouched', () => {
    makeRegistry();
    git(work, 'config', 'branch.main.pushRemote', 'fork');
    const upstreamBefore = bareHead(upstreamBare);

    const result = runEndorse({
      registryRepoRoot: work, packName: 'demo-pack', tier: 'endorsed', push: true,
    });

    expect(result.pushed).toBe(true);
    expect(result.push_remote).toBe('fork');
    const local = git(work, 'rev-parse', 'HEAD');
    // The observable fact: the endorsement commit is in the FORK bare repo…
    expect(bareHead(forkBare)).toBe(local);
    // …and upstream never moved.
    expect(bareHead(upstreamBare)).toBe(upstreamBefore);
    expect(bareHead(upstreamBare)).not.toBe(local);
  }, T);

  test('refuses to guess when the push remote is ambiguous — nothing is published', () => {
    makeRegistry();
    unset(work, 'branch.main.remote');
    const upstreamBefore = bareHead(upstreamBare);

    expect(() => runEndorse({
      registryRepoRoot: work, packName: 'demo-pack', tier: 'endorsed', push: true,
    })).toThrow(EndorseError);

    // The commit is local (recoverable); neither remote received it.
    expect(bareHead(upstreamBare)).toBe(upstreamBefore);
    expect(bareHead(forkBare)).toBe('');
  }, T);
});

describe('the generated bash push helper resolves the same way', () => {
  /** Render the committed helper into a fork-shaped repo via hardenBrainRepo's
   *  own installer, then invoke it for real. */
  async function installHelperInto(repo: string): Promise<string> {
    const { hardenBrainRepo } = await import('../src/core/brain-repo-durability.ts');
    await hardenBrainRepo({
      repoPath: repo, sourceId: 'fixture', branch: 'main',
      installCron: false, verify: false,
    });
    return join(repo, 'scripts', 'brain-commit-push.sh');
  }

  test('brain-commit-push.sh pushes to the fork, never to origin', async () => {
    makeForkShapedRepo();
    git(work, 'config', 'branch.main.pushRemote', 'fork');
    const gbrainHome = mkdtempSync(join(root, 'gbhome-'));
    const helper = await installHelperInto(work);
    expect(existsSync(helper)).toBe(true);
    // The helper must NOT contain a bare `git push origin` anymore.
    expect(readFileSync(helper, 'utf-8')).not.toMatch(/git push origin/);

    const upstreamBefore = bareHead(upstreamBare);
    mkdirSync(join(work, 'pages'), { recursive: true });
    writeFileSync(join(work, 'pages', 'note.md'), 'hello\n');

    execFileSync('bash', [helper, 'add note', 'pages/note.md'], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GBRAIN_HOME: gbrainHome },
    });

    const local = git(work, 'rev-parse', 'HEAD');
    expect(bareHead(forkBare)).toBe(local);
    expect(bareHead(upstreamBare)).toBe(upstreamBefore);
  }, T);

  test('refuses (exit 4, nothing pushed) when no push remote resolves', async () => {
    makeForkShapedRepo();
    const gbrainHome = mkdtempSync(join(root, 'gbhome-'));
    const helper = await installHelperInto(work);
    // Make resolution genuinely ambiguous AFTER the helper is installed.
    unset(work, 'branch.main.remote');

    const upstreamBefore = bareHead(upstreamBare);
    const forkBefore = bareHead(forkBare);
    mkdirSync(join(work, 'pages'), { recursive: true });
    writeFileSync(join(work, 'pages', 'note.md'), 'hello\n');

    let status = 0;
    try {
      execFileSync('bash', [helper, 'add note', 'pages/note.md'], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GBRAIN_HOME: gbrainHome },
      });
    } catch (e) { status = (e as { status?: number }).status ?? -1; }

    expect(status).toBe(4);
    expect(bareHead(upstreamBare)).toBe(upstreamBefore);
    expect(bareHead(forkBare)).toBe(forkBefore);
    expect(readFileSync(join(gbrainHome, 'brain-push.log'), 'utf-8')).toContain('no push remote could be resolved');
  }, T);
});
