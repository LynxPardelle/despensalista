#!/usr/bin/env bash
# CI-only: owns and removes its isolated Compose volume, never a developer volume.
set -euo pipefail
if [[ "${CI:-}" != "true" ]]; then
  echo 'Mongo Compose smoke must run on an isolated CI runner.' >&2
  exit 1
fi
compose_project="despensalista-mongo-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
export MONGO_INITDB_DATABASE=despensalista_smoke
export MONGO_APP_DATABASE=despensalista_smoke
export MONGO_INITDB_ROOT_USERNAME=smoke_root
export MONGO_APP_USERNAME=smoke_app
export MONGO_INITDB_ROOT_PASSWORD
export MONGO_APP_PASSWORD
MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)
MONGO_APP_PASSWORD=$(openssl rand -hex 24)
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "::add-mask::$MONGO_INITDB_ROOT_PASSWORD"
  echo "::add-mask::$MONGO_APP_PASSWORD"
fi
cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    docker compose --project-name "$compose_project" logs --tail 80 mongodb || true
  fi
  if ! docker compose --project-name "$compose_project" down --volumes --remove-orphans; then
    echo 'Mongo smoke cleanup failed; inspect this isolated runner.' >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose --project-name "$compose_project" up --detach --wait --wait-timeout 180 mongodb
docker compose --project-name "$compose_project" exec -T mongodb mongosh --quiet --file /dev/stdin \
  < .github/scripts/mongodb-transaction-smoke.js
