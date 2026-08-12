/**
 * Every gbrain push must land in the repo the checkout BELONGS to — never a
 * hardcoded `origin`.
 *
 * gbrain's push paths all operate on a CALLER-SUPPLIED repo: a brain source's
 * `local_path` (which `gbrain sources add --path` accepts as the user's own,
 * unowned working tree, and `gbrain sources harden --all` then sweeps) and the
 * skillpack registry root (which defaults to the CWD). Those are routinely
 * fork-shaped: `origin` is the UPSTREAM project the user does not own, and the
 * fork lives under a different remote name. A hardcoded `origin` publishes the
 * user's commits to that upstream.
 *
 * These tests drive real bare "upstream" and "fork" repos, so a regression
 * shows up as commits landing in the WRONG repo rather than as a mocked argv
 * assertion.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';
import { resolvePushRemote, listRemotes } from '../src/core/git-remote.ts';
import { runEndorse } from '../src/core/skillpack/endorse.ts';
import { REGISTRY_SCHEMA_VERSION } from '../src/core/skillpack/registry-schema.ts';

// `env: process.env` on every spawn is REQUIRED: Bun snapshots process.env at
// its own startup, so a spawned git is otherwise blind to the HOME /
// GBRAIN_HOME / GBRAIN_GIT_ALLOW_FILE_TRANSPORT mutations below and the test
// would pollute the operator's real ~/.gbrain (same quirk as #2747 / #2943).
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env,
  }).trim();
}

/** Branch tip in a bare repo, or '' when the branch does not exist there. */
function bareHead(bare: string, branch = 'main'): string {
  try { return git(bare, 'rev-parse', `refs/heads/${branch}`); } catch { return ''; }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

let root: string;
let upstream: string, fork: string, work: string;
let oldHome: string | undefined, oldGbrainHome: string | undefined, oldAllowFile: string | undefined;

/** The post-commit hook pushes detached; wait for its marker to clear so
 *  cleanup can't hit EBUSY on a live git process. */
async function waitForHookQuiescence(): Promise<void> {
  const activeDir = join(process.env.GBRAIN_HOME ?? '', 'push-active');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let active: string[] = [];
    try { active = readdirSync(activeDir); } catch { /* never created */ }
    if (active.length === 0) return;
    await delay(150);
  }
}

async function removeFixtureTree(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { rmSync(root, { recursive: true, force: true }); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM') || Date.now() >= deadline) return;
      await delay(50);
    }
  }
}

function initBare(path: string): void {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path], { stdio: 'ignore', env: process.env });
}

/**
 * A fork-shaped checkout: `origin` is the upstream project, `fork` is the
 * user's own repo, and the trunk has been retargeted at the fork — the exact
 * shape of `C:\Users\diego\gbrain` and of any contributor's registry clone.
 */
function makeForkShapedCheckout(name: string, seed: (dir: string) => void): {
  work: string; upstream: string; fork: string;
} {
  const up = join(root, `${name}-upstream.git`);
  const fk = join(root, `${name}-fork.git`);
  initBare(up); initBare(fk);

  const dir = mkdtempSync(join(root, `${name}-work-`));
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore', env: process.env });
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'tester');
  seed(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');

  git(dir, 'remote', 'add', 'origin', up);
  git(dir, 'remote', 'add', 'fork', fk);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'push', '-q', 'fork', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  // The retarget under test: main belongs to the fork, not upstream.
  git(dir, 'config', 'branch.main.remote', 'fork');
  git(dir, 'config', 'branch.main.merge', 'refs/heads/main');

  return { work: dir, upstream: up, fork: fk };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gpr-'));
  oldHome = process.env.HOME;
  oldGbrainHome = process.env.GBRAIN_HOME;
  oldAllowFile = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  process.env.GBRAIN_HOME = join(process.env.HOME, '.gbrain');
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';

  const made = makeForkShapedCheckout('brain', dir => {
    writeFileSync(join(dir, 'README.md'), 'init\n');
  });
  work = made.work; upstream = made.upstream; fork = made.fork;
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
  if (oldAllowFile === undefined) delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  else process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = oldAllowFile;
  await waitForHookQuiescence();
  await removeFixtureTree();
});

describe('resolvePushRemote', () => {
  test('prefers branch.<b>.pushRemote over every other signal', () => {
    git(work, 'config', 'branch.main.pushRemote', 'fork');
    git(work, 'config', 'remote.pushDefault', 'origin');
    expect(resolvePushRemote(work, 'main')).toBe('fork');
  });

  test('falls back to remote.pushDefault, then the branch remote', () => {
    git(work, 'config', 'remote.pushDefault', 'fork');
    expect(resolvePushRemote(work, 'feature')).toBe('fork');
    git(work, 'config', '--unset', 'remote.pushDefault');
    // branch.main.remote=fork (set by the fixture) covers a branch with no
    // config of its own — retargeting the trunk is how a fork is pointed home.
    expect(resolvePushRemote(work, 'feature')).toBe('fork');
  });

  test('ignores a config value that is a URL rather than a remote name', () => {
    // `branch.main.remote` may legitimately hold a URL; it names no remote.
    git(work, 'config', 'branch.main.remote', upstream);
    expect(listRemotes(work)).toEqual(['fork', 'origin']);
    // Nothing resolvable → REFUSE. `origin` exists, but in a fork-shaped repo
    // it is the upstream project, so "it exists" is not a reason to push there.
    expect(resolvePushRemote(work, 'main')).toBeNull();
  });

  test('uses a sole remote whatever it is called', () => {
    git(work, 'remote', 'remove', 'origin');
    git(work, 'config', '--unset', 'branch.main.remote');
    expect(resolvePushRemote(work, 'main')).toBe('fork');
  });

  test('refuses (null) rather than guessing when no remote resolves', () => {
    git(work, 'remote', 'remove', 'origin');
    git(work, 'remote', 'remove', 'fork');
    expect(resolvePushRemote(work, 'main')).toBeNull();
  });
});

describe('brain-repo durability push (sources harden)', () => {
  test('scaffolding is pushed to the fork, never to the upstream origin', async () => {
    const upstreamBefore = bareHead(upstream);

    const report = await hardenBrainRepo({
      repoPath: work, sourceId: 'wiki', pat: 'ghp_x', installCron: false,
    });

    expect(report.needs_attention).toEqual([]);
    expect(report.clean_against_origin).toBe(true);
    // The scaffolding commit exists locally...
    const head = git(work, 'rev-parse', 'HEAD');
    expect(head).not.toBe(upstreamBefore);
    // ...landed in the fork...
    expect(bareHead(fork)).toBe(head);
    // ...and the UPSTREAM never moved.
    expect(bareHead(upstream)).toBe(upstreamBefore);
  }, 240_000);

  test('the generated helper pushes brain writes to the fork, never upstream', async () => {
    await hardenBrainRepo({ repoPath: work, sourceId: 'wiki', pat: 'ghp_x', installCron: false });
    const upstreamBefore = bareHead(upstream);

    mkdirSync(join(work, 'people'), { recursive: true });
    writeFileSync(join(work, 'people', 'alice-example.md'), '# alice-example\n');
    execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'add page', 'people/alice-example.md'], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });

    const head = git(work, 'rev-parse', 'HEAD');
    expect(bareHead(fork)).toBe(head);
    expect(bareHead(upstream)).toBe(upstreamBefore);
  }, 240_000);

  test('the generated bash resolves its remote instead of naming origin', async () => {
    await hardenBrainRepo({ repoPath: work, sourceId: 'wiki', pat: 'ghp_x', installCron: false });
    // Both renders come from the ONE PUSH_RETRY template (D7); pin both.
    for (const p of [join(work, 'scripts', 'brain-commit-push.sh'), join(work, '.git', 'hooks', 'post-commit')]) {
      expect(existsSync(p)).toBe(true);
      const script = readFileSync(p, 'utf-8');
      expect(script).not.toMatch(/git push origin/);
      expect(script).not.toMatch(/git pull --rebase origin/);
      expect(script).toMatch(/brain_remote/);
    }
  }, 240_000);
});

describe('skillpack endorse push', () => {
  function makeRegistry(): { work: string; upstream: string; fork: string } {
    return makeForkShapedCheckout('registry', dir => {
      writeFileSync(join(dir, 'registry.json'), JSON.stringify({
        schema_version: REGISTRY_SCHEMA_VERSION,
        updated_at: '2026-08-12T00:00:00Z',
        skillpacks: [{
          name: 'widget-co-pack',
          description: 'example pack',
          author: 'A Contributor',
          author_handle: 'a-contributor',
          homepage: 'https://github.com/widget-co/pack',
          source: {
            kind: 'git' as const,
            url: 'https://github.com/widget-co/pack.git',
            pinned_commit: 'a'.repeat(40),
          },
          tarball_sha256: 'b'.repeat(64),
          gbrain_min_version: '0.36.0',
          default_tier: 'community' as const,
          tags: ['example'],
          validated_at: '2026-08-12T00:00:00Z',
          validation_run_id: 'r1',
          skills_count: 1,
          skills: ['skills/example'],
          version: '0.1.0',
        }],
      }, null, 2) + '\n');
    });
  }

  test('endorsement lands in the fork, never in the upstream registry', () => {
    const reg = makeRegistry();
    const upstreamBefore = bareHead(reg.upstream);

    const result = runEndorse({
      registryRepoRoot: reg.work, packName: 'widget-co-pack', tier: 'endorsed', push: true,
    });

    expect(result.pushed).toBe(true);
    expect(result.push_remote).toBe('fork');
    const head = git(reg.work, 'rev-parse', 'HEAD');
    expect(bareHead(reg.fork)).toBe(head);
    expect(bareHead(reg.upstream)).toBe(upstreamBefore);
  }, 60_000);

  test('refuses to push when no remote resolves', () => {
    const reg = makeRegistry();
    git(reg.work, 'remote', 'remove', 'origin');
    git(reg.work, 'remote', 'remove', 'fork');

    expect(() => runEndorse({
      registryRepoRoot: reg.work, packName: 'widget-co-pack', tier: 'endorsed', push: true,
    })).toThrow(/no push remote configured/);
  }, 60_000);
});
