#!/usr/bin/env bash
# Desliga o runner e derruba o cluster kind só quando NENHUM repositório registrado tem CI em andamento ou na fila.
# Chamado ao fim de cada PR; com PRs em sequência, só a última derruba (evita subir e descer a toda hora).
set -euo pipefail

SLUG="${1:?usage: runner-down.sh owner-repo}"
BASE="${RUNNER_HOME:-$HOME/.cache/router-runner}"

for f in "$BASE"/*/.repo; do
  repo="$(cat "$f")"
  active=0
  for status in in_progress queued; do
    n="$(gh run list -R "$repo" --status "$status" --json databaseId --jq length 2>/dev/null || echo 0)"
    active=$((active + n))
  done
  if [ "$active" -gt 0 ]; then
    echo "runner kept up: $active CI run(s) still active in $repo"
    exit 0
  fi
done

systemctl --user stop "router-runner@${SLUG}.service"
# Só derruba se o cluster existe (projetos sem Kubernetes nunca subiram um).
CLUSTER="${KIND_CLUSTER:-router-ci}"
if command -v kind >/dev/null && kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind delete cluster --name "$CLUSTER" || true
fi
