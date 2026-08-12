#!/usr/bin/env bash
#
# Conductor / git-worktree support for scripts/ci-local.sh.
#
# When `.git` is a FILE (not a directory) the checkout is a linked worktree and
# its gitdir lives outside the repo bind-mount. Without remounting that path,
# scripts/check-trailing-newline.sh and every other in-container `git` call
# exits 128 ("not a git repository").
#
# The HOST half and the CONTAINER half of the mount are computed SEPARATELY.
# Assuming one string serves as both is a Windows-only identity-transform trap
# — on macOS/Linux the two forms coincide, so CI can never catch it (same class
# as the `new URL().pathname` invariant in CLAUDE.md). Two independent defects,
# and the first hides the second:
#
#   1. HOST side of `-v`. Under MSYS/Git-Bash `pwd` yields `/c/Users/...`.
#      Docker Desktop does not resolve that as a Windows host path and mounts an
#      EMPTY directory rather than failing, so even a correct pointer would find
#      nothing there. Convert to `C:/Users/...` with cygpath.
#   2. CONTAINER side. The `.git` FILE is read verbatim out of the bind-mount
#      and holds a Windows-form `gitdir: C:/Users/...`. Git treats `C:/...` as
#      RELATIVE and resolves it against the working dir, producing
#      `fatal: not a git repository: /app/C:/Users/...`. So the common gitdir is
#      mounted at a FIXED container path and a normalized `.git` pointer file
#      naming that path is overlaid at /app/.git.
#
# `git config --global --add safe.directory '*'` in the runner swallows the
# first fatal, so a broken mount surfaces as an unexplained later failure rather
# than a clear diagnosis. Keep this helper's echoes; they are the diagnosis.
#
# The pointer is overlaid as its own bind-mount rather than exported as GIT_DIR:
# a process-wide GIT_DIR would also capture the `mkdtemp + git init` fixtures
# many unit tests build, which must stay independent repos.

set -u

GBRAIN_CI_CONTAINER_GITDIR="/gbrain-gitdir"

# Populates the GBRAIN_CI_EXTRA_MOUNTS array with the docker-run arguments the
# checkout needs (empty for a canonical checkout). Sets MSYS_NO_PATHCONV /
# MSYS2_ARG_CONV_EXCL in the caller's environment on MSYS, so it must be CALLED
# DIRECTLY — never inside a command substitution, which would lose the exports.
gbrain_ci_worktree_mounts() {
  local checkout="${1:-$PWD}"
  GBRAIN_CI_EXTRA_MOUNTS=()

  [ -f "$checkout/.git" ] || return 0

  local worktree_gitdir
  worktree_gitdir=$(awk '{print $2}' "$checkout/.git")
  [ -n "$worktree_gitdir" ] && [ -d "$worktree_gitdir" ] || return 0
  worktree_gitdir=$(cd "$worktree_gitdir" && pwd)

  local common_gitdir
  if [ -f "$worktree_gitdir/commondir" ]; then
    common_gitdir=$(cd "$worktree_gitdir" && cd "$(cat "$worktree_gitdir/commondir")" && pwd)
  else
    common_gitdir="$worktree_gitdir"
  fi

  # Container half: the worktree gitdir lives under the common gitdir, so
  # mounting the common dir covers worktrees/<name> automatically.
  local worktree_rel="${worktree_gitdir#"$common_gitdir"}"
  local container_worktree_gitdir="${GBRAIN_CI_CONTAINER_GITDIR}${worktree_rel}"

  # Host half: Windows form on MSYS/Cygwin, unchanged on macOS/Linux.
  local host_gitdir="$common_gitdir"
  local windows_host=0
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      if ! host_gitdir=$(cygpath -m "$common_gitdir" 2>/dev/null) || [ -z "$host_gitdir" ]; then
        echo "[ci-local] ERROR: MSYS shell without a working cygpath; cannot" >&2
        echo "[ci-local]   convert '$common_gitdir' to a Docker-resolvable host path." >&2
        GBRAIN_CI_EXTRA_MOUNTS=()
        return 2
      fi
      windows_host=1
      # MSYS rewrites POSIX-looking argv elements: the container halves of the
      # -v specs below would reach docker as 'C:/Program Files/Git/...'.
      export MSYS_NO_PATHCONV=1
      export MSYS2_ARG_CONV_EXCL='*'
      ;;
  esac

  # Normalized pointer file, overlaid at /app/.git. Its host path is
  # deterministic per checkout, so it neither accumulates across runs nor
  # collides between concurrent worktrees, and needs no cleanup hook.
  local pointer_key pointer_dir host_pointer
  pointer_key=$(printf '%s' "$checkout" | cksum | awk '{print $1}')
  pointer_dir="${TMPDIR:-/tmp}/gbrain-ci-gitptr-${pointer_key}"
  mkdir -p "$pointer_dir"
  printf 'gitdir: %s\n' "$container_worktree_gitdir" >"$pointer_dir/dotgit"
  host_pointer="$pointer_dir/dotgit"
  if [ "$windows_host" = "1" ]; then
    host_pointer=$(cygpath -m "$host_pointer")
  fi

  GBRAIN_CI_EXTRA_MOUNTS=(
    -v "${host_gitdir}:${GBRAIN_CI_CONTAINER_GITDIR}:ro"
    -v "${host_pointer}:/app/.git:ro"
  )
  echo "[ci-local] Worktree detected; mounting shared gitdir:"
  echo "[ci-local]   host      $host_gitdir"
  echo "[ci-local]   container $GBRAIN_CI_CONTAINER_GITDIR (worktree gitdir: $container_worktree_gitdir)"
}
