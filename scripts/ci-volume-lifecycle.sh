#!/usr/bin/env bash

set -u

gbrain_ci_validate_keep_volumes() {
  local keep_volumes="$1"
  [ "$keep_volumes" = "1" ] || return 0
  local compose_file="$2"
  local project="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
  if [ ! -d .git ]; then
    echo "[ci-local] ERROR: --keep-volumes is allowed only in the canonical gbrain checkout; worktree/ephemeral project '$project' would leak six volumes." >&2
    return 2
  fi

  local compose_config
  if ! compose_config=$(docker compose -f "$compose_file" config --format json); then
    echo "[ci-local] ERROR: could not resolve the effective Compose project; refusing --keep-volumes." >&2
    return 2
  fi
  if ! project=$(printf '%s\n' "$compose_config" | bun -e 'const input = await Bun.stdin.text(); const name = JSON.parse(input).name; if (typeof name !== "string" || name.length === 0) process.exit(1); process.stdout.write(name)'); then
    echo "[ci-local] ERROR: could not resolve the effective Compose project; refusing --keep-volumes." >&2
    return 2
  fi
  if [ "$project" != "gbrain" ]; then
    [ -n "$project" ] || project="<unknown>"
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
