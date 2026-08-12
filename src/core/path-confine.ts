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
 * LEXICAL directory-boundary test: true iff `child` is `parent` itself or lives
 * inside it. Pure string/path math — does NOT touch the filesystem, so callers
 * that already hold realpath-resolved (or deliberately unresolved) paths can use
 * it directly. For symlink-safe confinement of raw input, use `isPathContained`.
 *
 * THE ONE CORRECT IDIOM — do not hand-roll `child.startsWith(parent + '/')`.
 * That spelling has been reintroduced and fixed four separate times (sync ×3,
 * archive-crawler ×1) because it is an IDENTITY TRANSFORM on POSIX and therefore
 * invisible to gbrain's ubuntu-only CI. On Windows `resolve()`/`realpathSync()`
 * emit `\`, so a hardcoded `/` can never match at the boundary and the test is
 * pinned to `false` forever — silently turning an allow-fence into a dead
 * feature, or (worse) a deny-fence into a permanent pass. `scripts/check-path-
 * sep-boundary.sh` is the CI guard that keeps it from coming back a fifth time.
 *
 * `path.relative()` does the platform-specific work for us, which is precisely
 * why it beats a hand-rolled comparator:
 *   - separators: emits native `\` on win32 and accepts mixed input, so
 *     `C:/repo` and `C:\repo` compare equal;
 *   - case: win32 `relative()` is case-INSENSITIVE, matching NTFS — so a
 *     deny-list spelled `Private` still catches a candidate under `private`
 *     (the fail-open that 2847b60f called out). On POSIX it stays
 *     case-SENSITIVE and treats `\` as an ordinary filename character, which is
 *     the correct semantics there. No `process.platform` branch needed.
 *   - boundary: `/foo` does not match `/foobar`, because `relative()` returns
 *     `../foobar` rather than a `bar` suffix.
 *
 * The `..` test is spelled `rel === '..' || rel.startsWith('..' + sep)` rather
 * than a bare `rel.startsWith('..')` so a legitimately-named sibling directory
 * like `..config` is not misread as an escape.
 *
 * `isAbsolute(rel)` catches the win32 different-drive case: `relative('C:\\a',
 * 'D:\\b')` returns the absolute `D:\b`, since no relative path spans volumes.
 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;                              // same directory
  if (isAbsolute(rel)) return false;                        // different volume (win32)
  if (rel === '..' || rel.startsWith('..' + sep)) return false; // escapes upward
  return true;
}

/**
 * As `isPathInside`, but STRICT: `child` must live below `parent`, not be it.
 * Use where equality is meaningless or wrong — e.g. "is ~/.gbrain inside a git
 * worktree", where the worktree walk must start above `~/.gbrain` itself.
 */
export function isPathStrictlyInside(child: string, parent: string): boolean {
  return relative(parent, child) !== '' && isPathInside(child, parent);
}

/**
 * Symlink-safe path confinement: realpath BOTH sides, then a separator-aware
 * boundary check. A plain `startsWith()` on un-resolved paths would let a
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
  return isPathInside(resolvedChild, resolvedParent);
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
 * Resolve `target` through the deepest EXISTING ancestor using `resolver`, then
 * re-attach the not-yet-created tail lexically. Shared by the two "the path may
 * not exist yet" resolvers below; the resolver choice is what distinguishes
 * them (`realpathOrResolve` vs the short-name-collapsing native variant).
 */
function resolveViaExistingAncestor(target: string, resolver: (p: string) => string): string {
  let existing = resolvePath(target);
  const tail: string[] = [];
  for (let i = 0; i < 4096 && !existsSync(existing); i++) {
    tail.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break; // filesystem root
    existing = parent;
  }
  const base = resolver(existing);
  return tail.length ? join(base, ...tail) : base;
}

/**
 * Canonicalize a path for containment comparison, collapsing Windows 8.3 SHORT
 * NAMES so `C:\Users\DIEGO~1\AppData\Local\Temp` and
 * `C:\Users\diego\AppData\Local\Temp` compare equal.
 *
 * WHY A SEPARATE HELPER. `isPathInside` is pure `path.relative()` math, and
 * `realpathOrResolve` (hence `isPathContained` / `isWriteTargetContained`) uses
 * plain `realpathSync`, which does NOT expand short names on Windows. So a
 * caller that happens to hold the `DIEGO~1` spelling of `%TEMP%` is lexically
 * OUTSIDE the `diego` spelling `tmpdir()` returns, and a temp-containment fence
 * built on either one alone reads `false` and lets the write through. That is
 * the exact machine where the config-repoint incidents happened, and it is an
 * identity transform on POSIX, so ubuntu-only CI can never catch it.
 *
 * Only `realpathSync.native` collapses the short form. It requires the path to
 * exist, so we resolve through the deepest existing ancestor and re-attach the
 * tail — a migration target's leaf file typically does not exist yet, while its
 * mkdtemp parent does.
 *
 * Deliberately NOT folded into `realpathOrResolve`: that would change the
 * semantics of every registered-path prefix matcher, mount resolver and upload
 * fence at once. This is opt-in, for fences that must survive a short-name
 * spelling.
 *
 * The result still goes through `isPathInside` for the boundary test — never
 * compare it with `startsWith(parent + sep)`.
 */
export function canonicalizeNative(p: string): string {
  const native = (realpathSync as unknown as { native?: (x: string) => string }).native;
  return resolveViaExistingAncestor(p, (x) => {
    try {
      return native ? native(x) : realpathSync(x);
    } catch {
      return resolvePath(x);
    }
  });
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
  const finalPath = resolveViaExistingAncestor(target, realpathOrResolve);
  return isPathInside(finalPath, resolvedRoot);
}
