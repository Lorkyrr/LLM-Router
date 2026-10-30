#!/usr/bin/env bash
set -euo pipefail

REPO="${1:?usage: runner-uninstall.sh owner/repo}"
SLUG="${REPO//\//-}"
systemctl --user stop "router-runner@${SLUG}.service" || true
cd "${RUNNER_HOME:-$HOME/.cache/router-runner}/$SLUG"
./config.sh remove --token "$(gh api -X POST "repos/${REPO}/actions/runners/remove-token" --jq .token)"
