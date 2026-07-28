#!/usr/bin/env bash
# scripts/lib/proc-tree.sh — portable process-tree teardown helpers.
#
# Sourced by run-unit-parallel.sh and run-serial-tests.sh.
#
# Two hard constraints shaped this file:
#
# 1. NO pkill/pgrep. Those ship in procps, which is absent on Git-Bash and on
#    a default Cygwin install. There `pkill -P "$pid"` is a silent no-op — it
#    exits non-zero, the caller's `2>/dev/null` swallows it, and the tree
#    survives. That is one of the ways `bun run test` leaked whole process
#    trees on Windows.
#
# 2. `ps` IS TOO SLOW TO KILL WITH. Measured on the Windows box this was
#    written for: a single `ps -e` took 9-12 SECONDS under load. A teardown
#    that walks the process table before signalling anything gives the child
#    a ten-second head start — long enough to finish the very work we are
#    cancelling. So every entry point signals the pids it already knows via
#    the `kill` BUILTIN first (microseconds), and only then pays for a `ps`
#    sweep to catch grandchildren it could not have known about.
#
# All functions are safe to call with empty/missing pids and never fail the
# caller — they run from EXIT traps, where a non-zero return would clobber the
# script's real exit status.

# proc_pid_ppid_pairs: print "<pid> <ppid>" for every live process, one per
# line. Two dialects, probed in order:
#   1. POSIX ps (Linux, macOS, BSD) — explicit `-o pid=,ppid=` columns.
#   2. Cygwin / MSYS / Git-Bash ps — no `-o` support at all; fixed columns
#      "PID PPID PGID WINPID TTY UID STIME COMMAND" with a header row.
proc_pid_ppid_pairs() {
  local out
  out=$(ps -e -o pid=,ppid= 2>/dev/null) || out=""
  if printf '%s\n' "$out" | grep -qE '^[[:space:]]*[0-9]+[[:space:]]+[0-9]+'; then
    printf '%s\n' "$out"
    return 0
  fi
  ps -e 2>/dev/null | awk 'NR > 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { print $1, $2 }'
}

# proc_alive PID — true if the pid exists and we may signal it.
# `kill -0` is a shell builtin: this is the only liveness check cheap enough
# to poll in a loop, which is why the watchdogs use it instead of `ps`.
proc_alive() {
  [ -n "${1:-}" ] || return 1
  kill -0 "$1" 2>/dev/null
}

# proc_any_alive PID... — true if ANY of the given pids is still alive.
# Builtin-only, so callers can skip the expensive `ps` sweep on the happy path
# where every child already exited normally.
proc_any_alive() {
  local p
  for p in "$@"; do
    [ -n "$p" ] || continue
    if proc_alive "$p"; then return 0; fi
  done
  return 1
}

# proc_signal_pids SIGNAL PID... — instant builtin signal of known pids.
proc_signal_pids() {
  local sig="$1" p
  shift
  for p in "$@"; do
    [ -n "$p" ] || continue
    kill "-$sig" "$p" 2>/dev/null || true
  done
  return 0
}

# _proc_descendants_of PAIRS ROOT... — print every transitive descendant of
# the given roots (roots themselves excluded), one pid per line.
#
# Single awk pass over one snapshot. The earlier shape — recursing in bash and
# spawning an awk per node — cost ~4s PER NODE on the target box, which put
# teardown well past the deadline it was supposed to beat.
_proc_descendants_of() {
  local pairs="$1"
  shift
  printf '%s\n' "$pairs" | awk -v roots="$*" '
    { ppid[$1] = $2; pid[n++] = $1 }
    END {
      c = split(roots, R, " ")
      for (i = 1; i <= c; i++) if (R[i] != "") { mark[R[i]] = 1; isroot[R[i]] = 1 }
      # Fixpoint instead of recursion: bounded iterations make a pid-reuse
      # artefact in the snapshot incapable of looping forever.
      for (iter = 0; iter < 24; iter++) {
        changed = 0
        for (j = 0; j < n; j++) {
          p = pid[j]
          if (!mark[p] && (p in ppid) && mark[ppid[p]]) { mark[p] = 1; changed = 1 }
        }
        if (!changed) break
      }
      for (j = 0; j < n; j++) {
        p = pid[j]
        if (mark[p] && !isroot[p] && p > 1) print p
      }
    }
  '
}

# proc_kill_forest SIGNAL PID... — signal each named pid and its whole subtree.
#
# Ordering is deliberate: known pids get the builtin signal immediately, then
# ONE shared `ps` snapshot sweeps up grandchildren for every root at once.
proc_kill_forest() {
  local sig="$1"
  shift
  [ "$#" -gt 0 ] || return 0
  proc_signal_pids "$sig" "$@"
  local pairs
  pairs=$(proc_pid_ppid_pairs)
  local kids
  kids=$(_proc_descendants_of "$pairs" "$@")
  if [ -n "$kids" ]; then
    # shellcheck disable=SC2086 — intentional word splitting of the pid list.
    proc_signal_pids "$sig" $kids
  fi
  return 0
}

# proc_kill_tree PID [SIGNAL] — single-root convenience wrapper.
proc_kill_tree() {
  local root="${1:-}" sig="${2:-TERM}"
  [ -n "$root" ] || return 0
  [ "$root" -gt 1 ] 2>/dev/null || return 0
  proc_kill_forest "$sig" "$root"
  return 0
}

# proc_terminate_tree PID [GRACE_SECONDS] — polite TERM of the whole tree,
# then an unconditional KILL sweep of whatever is left.
#
# The KILL pass re-snapshots on purpose: a native child (bun.exe under Cygwin)
# can outlive the TERM, and its own children may have moved in the meantime.
proc_terminate_tree() {
  local root="${1:-}" grace="${2:-3}"
  [ -n "$root" ] || return 0
  proc_kill_forest TERM "$root"
  local waited=0
  while [ "$waited" -lt "$grace" ]; do
    proc_alive "$root" || break
    sleep 1
    waited=$((waited + 1))
  done
  proc_kill_forest KILL "$root"
  return 0
}
