#!/usr/bin/env bash
# Leva o branch atual até a main: PR, runner local, CI e, se verde, merge (rebase) e branch remoto apagado.
# Uso: ci/ship.sh "título" ["corpo"]
set -euo pipefail

TITLE="${1:?usage: ship.sh \"title\" [\"body\"]}"
BODY="${2:-}"
BASE="${BASE:-main}"
BRANCH="$(git branch --show-current)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
SLUG="${REPO//\//-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

git push -q -u origin "$BRANCH"
PR="$(gh pr list --head "$BRANCH" --json number --jq '.[0].number // empty')"
if [ -z "$PR" ]; then
  gh pr create --base "$BASE" --head "$BRANCH" --title "$TITLE" --body "$BODY" >/dev/null
  PR="$(gh pr list --head "$BRANCH" --json number --jq '.[0].number')"
fi

"$HERE/runner-up.sh" "$SLUG"
trap '"$HERE/runner-down.sh" "$SLUG"' EXIT

sleep 10 # o workflow demora a registrar o check logo após abrir o PR
gh pr checks "$PR" --watch
gh pr merge "$PR" --rebase
git push -q origin --delete "$BRANCH"
echo "PR #$PR merged"
