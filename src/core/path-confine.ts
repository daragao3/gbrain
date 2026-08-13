/**
 * Shared symlink-safe path-confinement + dotfile-trust helpers.
 *
 * Consolidates the realpath-containment idiom that previously lived only in
 * `sources-ops.ts` (`isPathContained`) and `validateUploadPath`
 * (`operations.ts`), and adds `isTrustedDotfile` — the multi-user-host trust
 * gate for walk-up routing dotfiles (`.gbrain-source` / `.gbrain-mount`).
 *
 * Threat model (POSIX multi-user host): an attacker who can write into a
 * shared ancestor directory of the victim's CWD (`/tmp`, `/var/tmp`,
 * `/dev/shm`, shared NFS/SMB, CI runner volumes, container bind-mounts) can
 * plant a routing dotfile that silently retargets the victim's reads/writes
 * to the attacker's source/brain. The walk-up resolvers must therefore refuse
 * a dotfile they can't prove the victim (or root) owns. (#418/#419)
 *
 * Fail-closed: any stat/realpath error → not trusted / not contained. The one
 * documented exception is platforms without numeric uid (Windows), where the
 * multi-user-POSIX threat model does not apply and `isTrustedDotfile` trusts
 * by default so existing single-user setups keep working.
 */

import { realpathSync, existsSync, type Stats } from 'fs';
import { resolve as resolvePath, relative, isAbsolute, sep, dirname, basename, join } from 'path';

/**
 * Lexical, separator-agnostic containment: is `child` the same path as
 * `parent`, or somewhere inside it?
 *
 * THIS IS THE CANONICAL CONTAINMENT PRIMITIVE — reach for it instead of
 * hand-rolling `child.startsWith(parent + '/')`. That idiom is a Windows
 * defect: `resolve()` / `realpathSync()` emit the platform separator, so on
 * win32 the child is `C:\root\file` while the probe is `C:\root/` and the
 * comparison is ALWAYS false. Depending on which way the caller reads it that
 * is either fail-closed (every legitimate path rejected) or fail-open (a
 * containment check that never fires). It is an identity transform on POSIX,
 * so a green Linux CI run proves nothing. Guarded by
 * `scripts/check-posix-path-separator.sh`.
 *
 * Purely lexical — no filesystem access, no symlink resolution. Callers that
 * need symlink safety must realpath both sides first (see `isPathContained`).
 *
 * `relative()` handles the separator, `.` / `..` normalization, and (on
 * Windows) returns an ABSOLUTE path when the two sides sit on different
 * drives — hence the `isAbsolute` guard. The `..` test is separator-qualified
 * so a legitimately-named child like `<parent>/..config` is not mistaken for
 * a traversal.
 *
 * CASE: `path.relative()` compares Windows paths case-insensitively. That is
 * convenient on ordinary NTFS directories, but Windows also supports
 * per-directory case sensitivity: `root` and `ROOT` can be distinct siblings.
 * Treating them as equal would turn this security boundary fail-open. On win32
 * we therefore require the resolved strings to share an exact-case directory
 * prefix before trusting `relative()`. Only the drive letter is folded because
 * `C:` and `c:` always identify the same drive. A casing disagreement anywhere
 * else fails closed; callers that need to accept alternate spelling can
 * canonicalize it before calling this lexical primitive.
 */
const CASE_INSENSITIVE_DRIVE = /^[a-z]:/i;

function normalizeDriveCase(p: string): string {
  if (process.platform !== 'win32' || !CASE_INSENSITIVE_DRIVE.test(p)) return p;
  return p[0].toUpperCase() + p.slice(1);
}

export function isPathWithin(child: string, parent: string): boolean {
  const from = normalizeDriveCase(resolvePath(parent));
  const to = normalizeDriveCase(resolvePath(child));
  if (
    process.platform === 'win32' &&
    to !== from &&
    !to.startsWith(from + sep)
  ) {
    return false;
  }
  const rel = relative(from, to);
  if (rel === '') return true; // same path
  if (isAbsolute(rel)) return false; // different drive (win32)
  return rel !== '..' && !rel.startsWith('..' + sep);
}

/**
 * Symlink-safe path confinement: realpath BOTH sides, then a separator-aware
 * containment check. A plain `startsWith()` on un-resolved paths would let a
 * `parent/skills` symlink → `/etc` (or `$GBRAIN_HOME/clones/<id>` → `/etc`)
 * bypass the boundary; resolving first defeats that.
 *
 * Returns true iff `child` exists AND its realpath is `parent`'s realpath or a
 * real subtree of it. Returns false if either path is unresolvable (missing /
 * permission) or the resolved child escapes — fail-closed.
 */
export function isPathContained(child: string, parent: string): boolean {
  let resolvedChild: string;
  let resolvedParent: string;
  try {
    resolvedChild = realpathSync(child);
    resolvedParent = realpathSync(parent);
  } catch {
    return false; // missing / unresolvable path → not contained
  }
  return isPathWithin(resolvedChild, resolvedParent);
}

/**
 * Trust gate for a walk-up routing dotfile, given its `lstatSync` Stats.
 *
 * The caller MUST pass an `lstatSync` result, never `statSync` — `lstat` does
 * not follow symlinks, so a planted symlink redirect is visible here as
 * `isSymbolicLink()` instead of being followed-then-trusted.
 *
 * Rejects three classes of untrusted file:
 *   1. symlinks — an attacker-planted redirect to a file they control;
 *   2. foreign-owned — `uid` is neither the caller's nor root's (an attacker
 *      can't `chown` a file to the victim, so foreign ownership means planted;
 *      root-owned is trusted — root is the system admin and can write anywhere
 *      regardless);
 *   3. world-writable (`mode & 0o002`) — anyone can clobber it later, even when
 *      ownership is currently legitimate.
 *
 * On platforms without `process.getuid` (Windows) returns true: the
 * multi-user-POSIX threat model does not apply and ownership is unknowable.
 */
export function isTrustedDotfile(stats: Stats): boolean {
  // No numeric uid (Windows) → can't verify ownership; threat model N/A.
  if (typeof process.getuid !== 'function') return true;
  // A symlink is an attacker redirect — never trust. (Requires an lstat Stats.)
  if (stats.isSymbolicLink()) return false;
  const myUid = process.getuid();
  // Foreign-owned (not me, not root) → planted. Root-owned is trusted.
  if (stats.uid !== myUid && stats.uid !== 0) return false;
  // World-writable → anyone can clobber it later, even when ownership is legit.
  if ((stats.mode & 0o002) !== 0) return false;
  return true;
}

/**
 * Resolve a path through symlinks, falling back to lexical `resolve()` when the
 * path doesn't exist (stale registration). Used by the registered-path prefix
 * matchers so a symlinked CWD can't create a false prefix match against a
 * registered `local_path` / mount path while still tolerating a registered path
 * that no longer exists on disk.
 */
export function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

/**
 * Containment check for a write TARGET that may not exist yet (a new page file).
 * `isPathContained` requires the child to already exist; this instead realpaths
 * the deepest EXISTING ancestor of `target` (catching a symlinked intermediate
 * directory that escapes the tree) and re-attaches the not-yet-created tail
 * lexically, then confirms the result stays within `root`.
 *
 * Defense-in-depth for the write-through FS sink (#1647-slug / codex #6):
 * `validateSlug` already rejects `..`/backslash/control/%2e in the slug, so this
 * guards a pre-existing hostile row or a symlinked source-tree subdirectory.
 */
export function isWriteTargetContained(target: string, root: string): boolean {
  const resolvedRoot = realpathOrResolve(root);
  let existing = resolvePath(target);
  const tail: string[] = [];
  for (let i = 0; i < 4096 && !existsSync(existing); i++) {
    tail.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break; // filesystem root
    existing = parent;
  }
  const base = realpathOrResolve(existing);
  const finalPath = tail.length ? join(base, ...tail) : base;
  return isPathWithin(finalPath, resolvedRoot);
}
