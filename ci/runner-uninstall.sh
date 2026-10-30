#!/usr/bin/env bash
set -euo pipefail

REPO="${1:?usage: runner-uninstall.sh owner/repo}"
cd "${RUNNER_DIR:-$HOME/actions-runner}"
systemctl --user stop router-runner.service || true
rm -f "$HOME/.config/systemd/user/router-runner.service"
./config.sh remove --token "$(gh api -X POST "repos/${REPO}/actions/runners/remove-token" --jq .token)"
