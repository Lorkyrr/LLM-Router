#!/usr/bin/env bash
set -euo pipefail

REPO="${1:?usage: runner-uninstall.sh owner/repo}"
cd "${RUNNER_DIR:-$HOME/actions-runner}"
sudo ./svc.sh stop || true
sudo ./svc.sh uninstall || true
./config.sh remove --token "$(gh api -X POST "repos/${REPO}/actions/runners/remove-token" --jq .token)"
