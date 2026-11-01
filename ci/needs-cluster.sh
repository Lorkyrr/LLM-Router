#!/usr/bin/env bash
# Decide se o CI precisa subir um cluster kind. Uso: ci/needs-cluster.sh [diretório-do-projeto]
# stdout: "kind" ou "off" (para $GITHUB_OUTPUT); stderr: o motivo. Sempre sai 0, exceto valor inválido (2).
# Precedência: CI_CLUSTER (env) > verify.cluster em config/router.yaml > auto (detecção abaixo).
set -euo pipefail

DIR="${1:-.}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mode="${CI_CLUSTER:-}"
src="CI_CLUSTER"

if [ -z "$mode" ] && [ -f "$DIR/config/router.yaml" ]; then
  mode="$(node -e 'const {parse}=require(require.resolve("yaml",{paths:[process.argv[1]]}));console.log(parse(require("fs").readFileSync(process.argv[2],"utf8"))?.verify?.cluster??"")' "$HERE/.." "$DIR/config/router.yaml")"
  src="verify.cluster"
fi
mode="${mode:-auto}"

decide() { echo "cluster: $1 ($2)" >&2; echo "$1"; exit 0; }

case "$mode" in
  kind|off) decide "$mode" "forced by $src" ;;
  auto) ;;
  *) echo "invalid cluster mode '$mode' ($src): use auto|kind|off" >&2; exit 2 ;;
esac

PRUNE=(\( -name node_modules -o -name .git -o -name .worktrees -o -name vendor \) -prune -o)
files() { find "$DIR" "${PRUNE[@]}" -type f "$@" -print -quit; }
yaml_in() { find "$1" -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.tpl' \) -print -quit; }

hit="$(files \( -name Chart.yaml -o -name kustomization.yaml -o -name kustomization.yml \))"
[ -n "$hit" ] && decide kind "Helm/Kustomize: $hit"

if [ -f "$DIR/PROJECT" ] && grep -qE '^(layout|projectName|domain):' "$DIR/PROJECT"; then
  decide kind "kubebuilder/operator-sdk PROJECT file"
fi

# YAML com apiVersion + kind no topo = recurso k8s (inclui CustomResourceDefinition).
while IFS= read -r f; do
  grep -qE '^kind:[[:space:]]*[A-Za-z]' "$f" && decide kind "k8s manifest: $f"
done < <(find "$DIR" "${PRUNE[@]}" -type f \( -name '*.yaml' -o -name '*.yml' \) -exec grep -lE '^apiVersion:[[:space:]]*[A-Za-z]' {} +)

# Pastas típicas só contam se tiverem YAML dentro (deploy/ com scripts não é manifest).
while IFS= read -r d; do
  hit="$(yaml_in "$d")"
  [ -n "$hit" ] && decide kind "k8s directory: $hit"
done < <(find "$DIR" "${PRUNE[@]}" -type d \( -name k8s -o -name deploy -o -name manifests -o -name charts \) -print)

# Testes que falam com cluster (os do próprio detector citam kubectl como fixture: ignorados).
while IFS= read -r f; do
  grep -qE '\bkubectl\b|KUBECONFIG|@kubernetes/client-node|envtest' "$f" && decide kind "test uses the cluster: $f"
done < <(find "$DIR" "${PRUNE[@]}" -type f \( -name '*.test.*' -o -name '*.spec.*' -o -name '*_test.*' -o -name 'test_*' -o -path '*/e2e/*' -o -path '*/tests/*' \) ! -name 'needs-cluster*' -print)

decide off "no Kubernetes signals found"
