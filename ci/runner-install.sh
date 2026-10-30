#!/usr/bin/env bash
# Instala o runner self-hosted do GitHub neste PC (CPU, como serviço systemd).
# Uso: ci/runner-install.sh owner/repo   (precisa de `gh` autenticado com permissão de admin no repositório e de sudo)
set -euo pipefail

REPO="${1:?usage: runner-install.sh owner/repo}"
DIR="${RUNNER_DIR:-$HOME/actions-runner}"
LABELS="router-ci"

mkdir -p "$DIR" && cd "$DIR"

if [ ! -x ./config.sh ]; then
  VERSION="$(gh api repos/actions/runner/releases/latest --jq '.tag_name' | sed 's/^v//')"
  curl -fsSL -o runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${VERSION}/actions-runner-linux-x64-${VERSION}.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
fi

# O token de registro expira em 1h; não é gravado em lugar nenhum.
TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token)"
./config.sh --unattended --url "https://github.com/${REPO}" --token "$TOKEN" \
  --name "$(hostname)-router" --labels "$LABELS" --replace

sudo ./svc.sh install "$USER"
sudo ./svc.sh start
echo "runner registered with label $LABELS; check: gh api repos/${REPO}/actions/runners --jq '.runners[].status'"
