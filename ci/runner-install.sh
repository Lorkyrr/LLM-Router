#!/usr/bin/env bash
# Registra o runner self-hosted do GitHub neste PC (CPU) como serviço systemd de usuário, desligado.
# Uso: ci/runner-install.sh owner/repo   (precisa de `gh` autenticado com permissão de admin no repositório )
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

# Unidade de usuário (sem sudo) e SEM enable/start: o router liga com ci/runner-up.sh quando abre um PR.
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/router-runner.service" <<UNIT
[Unit]
Description=GitHub Actions runner (router-ci), ligado sob demanda

[Service]
WorkingDirectory=$DIR
ExecStart=$DIR/run.sh
Restart=no
UNIT
systemctl --user daemon-reload
echo "runner registered (stopped). start: ci/runner-up.sh  stop: ci/runner-down.sh"
