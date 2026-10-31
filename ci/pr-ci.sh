#!/usr/bin/env bash
# CI de um PR já checado em $PWD: testes contra a base estável (só regressão conta), typecheck e cluster kind.
# Usado pelo router-verify (um PR) e pelo router-release (todos os PRs do router, no sinal do usuário).
# Uso: BASE_REF=main ci/pr-ci.sh
set -euo pipefail

BASE_REF="${BASE_REF:-main}"
TMP="${RUNNER_TEMP:-$(mktemp -d)}"
TESTS=(node --import tsx --test --test-reporter=tap "src/**/*.test.ts" "hooks/**/*.test.ts")
HERE="$(cd "$(dirname "$0")" && pwd)"

npm ci
# O cluster fica de pé entre PRs; ci/runner-down.sh o derruba quando não há mais CI em andamento.
"$HERE/kind-up.sh"

# Base estável: o último estado da branch alvo. Falha que já existia lá não bloqueia o PR.
BASE_DIR="$TMP/base-$$"
git worktree remove -f "$BASE_DIR" 2>/dev/null || rm -rf "$BASE_DIR"
git worktree prune
: > "$TMP/base-$$.tap"
git worktree add --detach "$BASE_DIR" "origin/$BASE_REF"
# npm ci falhando no base é problema de infraestrutura, não regressão: base.tap fica vazio (= sem baseline).
if (cd "$BASE_DIR" && npm ci); then
  (cd "$BASE_DIR" && "${TESTS[@]}" > "$TMP/base-$$.tap" || true)
else
  echo "::warning::npm ci failed on base origin/$BASE_REF (infra problem, not a PR regression); running without baseline"
fi
git worktree remove -f "$BASE_DIR" || true

"${TESTS[@]}" "ci/**/*.test.ts" | tee "$TMP/pr-$$.tap" || true
node ci/compare-baseline.ts "$TMP/base-$$.tap" "$TMP/pr-$$.tap"
npm run typecheck
