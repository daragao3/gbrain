#!/usr/bin/env bash

set -u

gbrain_ci_validate_keep_volumes() {
  local keep_volumes="$1"
  [ "$keep_volumes" = "1" ] || return 0
  local project="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
  if [ -f .git ] || [ "$project" != "gbrain" ]; then
    echo "[ci-local] ERROR: --keep-volumes is allowed only in the canonical gbrain checkout; worktree/ephemeral project '$project' would leak six volumes." >&2
    return 2
  fi
}

gbrain_ci_cleanup() {
  local ci_status="$1"
  local compose_file="$2"
  local keep_volumes="$3"
  trap - EXIT
  echo ""
  if [ "$keep_volumes" = "1" ]; then
    echo "[ci-local] Tearing down containers; explicitly retaining six CI volumes."
    docker compose -f "$compose_file" down --remove-orphans || true
  else
    echo "[ci-local] Tearing down containers and ephemeral CI volumes."
    docker compose -f "$compose_file" down -v --remove-orphans || true
  fi
  exit "$ci_status"
}
