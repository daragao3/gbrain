import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeLoad as yamlSafeLoad } from 'js-yaml';
import { repoPath } from './helpers/repo-root.ts';

const LIFECYCLE_SCRIPT = repoPath('scripts', 'ci-volume-lifecycle.sh').replaceAll('\\', '/');
const COMPOSE_FILE = repoPath('docker-compose.ci.yml');
const CI_LOCAL_EXIT_TRAP = readFileSync(repoPath('scripts', 'ci-local.sh'), 'utf8')
  .split(/\r?\n/)
  .find((line) => line.startsWith("trap 'gbrain_ci_cleanup"));
const BASH = process.platform === 'win32'
  ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';

interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  dockerCalls: string;
}

function runLifecycle(
  command: string,
  options: {
    cwdName?: string;
    gitKind?: 'directory' | 'file';
    composeProjectName?: string;
    envFileComposeProjectName?: string;
    dockerExitCode?: string;
  } = {},
): BashResult {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-ci-volume-lifecycle-'));
  const cwd = join(root, options.cwdName ?? 'checkout');
  const callLog = join(root, 'docker-calls.log');
  mkdirSync(cwd, { recursive: true });

  if (options.gitKind === 'directory') mkdirSync(join(cwd, '.git'));
  if (options.gitKind === 'file') writeFileSync(join(cwd, '.git'), 'gitdir: elsewhere\n');
  if (options.envFileComposeProjectName !== undefined) {
    writeFileSync(join(cwd, '.env'), `COMPOSE_PROJECT_NAME=${options.envFileComposeProjectName}\n`);
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.DOCKER_CALL_LOG = callLog.replaceAll('\\', '/');
  if (options.dockerExitCode !== undefined) env.DOCKER_EXIT_CODE = options.dockerExitCode;
  delete env.COMPOSE_PROJECT_NAME;
  if (options.composeProjectName !== undefined) {
    env.COMPOSE_PROJECT_NAME = options.composeProjectName;
  }

  try {
    const dockerFunction = `docker() {
  printf '%s\\n' "$*" >> "$DOCKER_CALL_LOG"
  if [ "$*" = "compose -f docker-compose.ci.yml config --format json" ]; then
    local project="\${COMPOSE_PROJECT_NAME:-}"
    if [ -z "$project" ] && [ -f .env ]; then
      project=$(sed -n 's/^[[:space:]]*COMPOSE_PROJECT_NAME[[:space:]]*=[[:space:]]*//p' .env | tail -1)
    fi
    project="\${project:-$(basename "$PWD")}"
    printf '{"name":"%s"}\\n' "$project"
  fi
  return "\${DOCKER_EXIT_CODE:-0}"
}`;
    const result = Bun.spawnSync(
      [
        BASH,
        '-c',
        `set -euo pipefail\n${dockerFunction}\nsource "$1"\n${command}`,
        'ci-volume-lifecycle-test',
        LIFECYCLE_SCRIPT,
      ],
      { cwd, env },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      dockerCalls: readFileSync(callLog, { encoding: 'utf8', flag: 'a+' }),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('CI volume lifecycle', () => {
  test('default cleanup removes volumes and preserves the CI exit status', () => {
    const result = runLifecycle('gbrain_ci_cleanup 7 docker-compose.ci.yml 0');

    expect(result.exitCode).toBe(7);
    expect(result.dockerCalls).toBe('compose -f docker-compose.ci.yml down -v --remove-orphans\n');
  });

  test('keep mode retains volumes and exits successfully', () => {
    const result = runLifecycle('gbrain_ci_cleanup 0 docker-compose.ci.yml 1');

    expect(result.exitCode).toBe(0);
    expect(result.dockerCalls).toBe('compose -f docker-compose.ci.yml down --remove-orphans\n');
  });

  test('keep mode rejects a worktree checkout whose .git is a file', () => {
    const result = runLifecycle('gbrain_ci_validate_keep_volumes 1 docker-compose.ci.yml', {
      gitKind: 'file',
      composeProjectName: 'gbrain',
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--keep-volumes is allowed only in the canonical gbrain checkout');
  });

  test('keep mode rejects a checkout with no .git directory', () => {
    const result = runLifecycle('gbrain_ci_validate_keep_volumes 1 docker-compose.ci.yml', {
      cwdName: 'gbrain',
      composeProjectName: 'gbrain',
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--keep-volumes is allowed only in the canonical gbrain checkout');
    expect(result.dockerCalls).toBe('');
  });

  test('keep mode rejects a noncanonical directory basename without an override', () => {
    const result = runLifecycle('gbrain_ci_validate_keep_volumes 1 docker-compose.ci.yml', {
      cwdName: 'gbrain-worktree',
      gitKind: 'directory',
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("project 'gbrain-worktree' would leak six volumes");
  });

  test('keep mode rejects a noncanonical COMPOSE_PROJECT_NAME', () => {
    const result = runLifecycle('gbrain_ci_validate_keep_volumes 1 docker-compose.ci.yml', {
      cwdName: 'gbrain',
      gitKind: 'directory',
      composeProjectName: 'gbrain-debug',
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("project 'gbrain-debug' would leak six volumes");
  });

  test('keep mode rejects a noncanonical project resolved from .env', () => {
    const result = runLifecycle('gbrain_ci_validate_keep_volumes 1 docker-compose.ci.yml', {
      cwdName: 'gbrain',
      gitKind: 'directory',
      envFileComposeProjectName: 'gbrain-debug',
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("project 'gbrain-debug' would leak six volumes");
    expect(result.dockerCalls).toBe(
      'compose -f docker-compose.ci.yml config --format json\n',
    );
  });

  test('environment project name takes precedence over a .env override', () => {
    const result = runLifecycle('gbrain_ci_validate_keep_volumes 1 docker-compose.ci.yml', {
      cwdName: 'gbrain',
      gitKind: 'directory',
      composeProjectName: 'gbrain',
      envFileComposeProjectName: 'gbrain-debug',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.dockerCalls).toBe(
      'compose -f docker-compose.ci.yml config --format json\n',
    );
  });

  test('keep mode accepts the canonical gbrain checkout without an override', () => {
    const result = runLifecycle('gbrain_ci_validate_keep_volumes 1 docker-compose.ci.yml', {
      cwdName: 'gbrain',
      gitKind: 'directory',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.dockerCalls).toBe(
      'compose -f docker-compose.ci.yml config --format json\n',
    );
  });

  test('EXIT trap preserves a nonzero CI status when cleanup fails', () => {
    expect(CI_LOCAL_EXIT_TRAP).toBeDefined();
    const result = runLifecycle(
      `COMPOSE_FILE=docker-compose.ci.yml
KEEP_VOLUMES=0
${CI_LOCAL_EXIT_TRAP}
(exit 7)`,
      { dockerExitCode: '19' },
    );

    expect(result.exitCode).toBe(7);
    expect(result.dockerCalls).toBe(
      'compose -f docker-compose.ci.yml down -v --remove-orphans\n',
    );
  });

  test('EXIT trap preserves a zero CI status when cleanup fails', () => {
    expect(CI_LOCAL_EXIT_TRAP).toBeDefined();
    const result = runLifecycle(
      `COMPOSE_FILE=docker-compose.ci.yml
KEEP_VOLUMES=0
${CI_LOCAL_EXIT_TRAP}
true`,
      { dockerExitCode: '19' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.dockerCalls).toBe(
      'compose -f docker-compose.ci.yml down -v --remove-orphans\n',
    );
  });

  test('all six CI volumes carry ephemeral lifecycle labels', () => {
    const compose = yamlSafeLoad(readFileSync(COMPOSE_FILE, 'utf8')) as {
      volumes: Record<string, { labels?: Record<string, string> }>;
    };
    const expectedVolumes = [
      'gbrain-ci-pg-data-1',
      'gbrain-ci-pg-data-2',
      'gbrain-ci-pg-data-3',
      'gbrain-ci-pg-data-4',
      'gbrain-ci-node-modules',
      'gbrain-ci-bun-cache',
    ];

    expect(Object.keys(compose.volumes).sort()).toEqual([...expectedVolumes].sort());
    for (const volume of expectedVolumes) {
      expect(compose.volumes[volume]?.labels).toEqual({
        'com.gbrain.ci.volume': 'true',
        'com.gbrain.ci.retention': 'ephemeral',
      });
    }
  });
});
