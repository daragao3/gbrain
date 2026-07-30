import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface FsCapabilities {
  fileSymlink: boolean;
  directorySymlink: boolean;
  directoryJunction: boolean;
  gitSymlinkCheckout: boolean;
}

const UNAVAILABLE_CODES = new Set(['ENOENT', 'EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN']);
const cache = new Map<string, FsCapabilities>();
const DEFAULT_CACHE_KEY = '<default-temp-filesystem>';

function isUnavailable(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && UNAVAILABLE_CODES.has(String((error as NodeJS.ErrnoException).code));
}

function probe(createAndVerify: (dir: string) => void, root: string, prefix: string): boolean {
  const dir = mkdtempSync(join(root, prefix));
  try {
    createAndVerify(dir);
    return true;
  } catch (error) {
    if (isUnavailable(error)) return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function probeFileSymlink(root: string): boolean {
  return probe((dir) => {
    const target = join(dir, 'target.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(target, 'file-symlink-probe');
    symlinkSync(target, link, 'file');
    if (readFileSync(link, 'utf8') !== 'file-symlink-probe') {
      throw new Error('file symlink probe did not read target content');
    }
    unlinkSync(link);
    if (readdirSync(dir).includes('link.txt')) throw new Error('file symlink probe did not remove link');
  }, root, '.gbrain-file-symlink-');
}

function probeDirectorySymlink(root: string): boolean {
  return probe((dir) => {
    const target = join(dir, 'target');
    const link = join(dir, 'link');
    mkdirSync(target);
    writeFileSync(join(target, 'marker.txt'), 'directory-symlink-probe');
    symlinkSync(target, link, 'dir');
    if (readFileSync(join(link, 'marker.txt'), 'utf8') !== 'directory-symlink-probe') {
      throw new Error('directory symlink probe did not read target content');
    }
    unlinkSync(link);
    if (readdirSync(dir).includes('link')) throw new Error('directory symlink probe did not remove link');
  }, root, '.gbrain-directory-symlink-');
}

function probeDirectoryJunction(root: string): boolean {
  if (process.platform !== 'win32') return false;
  return probe((dir) => {
    const target = join(dir, 'target');
    const link = join(dir, 'link');
    mkdirSync(target);
    writeFileSync(join(target, 'marker.txt'), 'junction-probe');
    symlinkSync(target, link, 'junction');
    if (readFileSync(join(link, 'marker.txt'), 'utf8') !== 'junction-probe') {
      throw new Error('directory junction probe did not read target content');
    }
    unlinkSync(link);
    if (readdirSync(dir).includes('link')) throw new Error('directory junction probe did not remove link');
  }, root, '.gbrain-directory-junction-');
}

function git(cwd: string, executable: string, args: string[], input?: string): string {
  return execFileSync(executable, args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function probeGitSymlinkCheckout(root: string, gitExecutable: string): boolean {
  const dir = mkdtempSync(join(root, '.gbrain-git-symlink-'));
  const emptyHooks = join(dir, 'empty-hooks');
  try {
    mkdirSync(emptyHooks);
    const withNoHooks = (args: string[], input?: string): string => git(dir, gitExecutable, [
      '-c', `core.hooksPath=${emptyHooks}`,
      ...args,
    ], input);
    withNoHooks(['init', '--quiet']);
    writeFileSync(join(dir, 'target.txt'), 'git-symlink-target');
    withNoHooks(['add', 'target.txt']);
    const blob = withNoHooks(['hash-object', '-w', '--stdin'], 'target.txt');
    withNoHooks(['update-index', '--add', '--cacheinfo', `120000,${blob},link.txt`]);
    withNoHooks([
      '-c', 'user.name=gbrain-test',
      '-c', 'user.email=gbrain-test@example.invalid',
      '-c', 'commit.gpgSign=false',
      'commit', '--quiet', '-m', 'probe git symlink checkout',
    ]);
    rmSync(join(dir, 'link.txt'), { force: true });
    withNoHooks(['checkout', '--', 'link.txt']);
    const link = join(dir, 'link.txt');
    const available = lstatSync(link).isSymbolicLink() && readlinkSync(link) === 'target.txt';
    rmSync(link, { force: true });
    return available;
  } catch (error) {
    if (isUnavailable(error)) return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function getFsCapabilities(
  root?: string,
  opts: { gitExecutable?: string } = {},
): FsCapabilities {
  if (root !== undefined) mkdirSync(root, { recursive: true });
  const gitExecutable = opts.gitExecutable ?? 'git';
  const canonicalRoot = root === undefined ? undefined : realpathSync(resolve(root));
  const cacheKey = `${canonicalRoot ?? DEFAULT_CACHE_KEY}\0git=${gitExecutable}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const probeRoot = canonicalRoot
    ?? mkdtempSync(join(tmpdir(), 'gbrain-fs-capabilities-root-'));
  try {
    const capabilities: FsCapabilities = Object.freeze({
      fileSymlink: probeFileSymlink(probeRoot),
      directorySymlink: probeDirectorySymlink(probeRoot),
      directoryJunction: probeDirectoryJunction(probeRoot),
      gitSymlinkCheckout: probeGitSymlinkCheckout(probeRoot, gitExecutable),
    });
    cache.set(cacheKey, capabilities);
    return capabilities;
  } finally {
    if (root === undefined) rmSync(probeRoot, { recursive: true, force: true });
  }
}
