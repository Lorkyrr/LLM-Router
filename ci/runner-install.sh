#!/usr/bin/env bash
# Registra um runner self-hosted (CPU) para UM repositório, desligado. Conta pessoal do GitHub não tem
# runner global, então cada projeto roda isto uma vez. Uso: ci/runner-install.sh owner/repo
# Precisa de `gh` autenticado com admin no repositório. Não usa sudo.
set -euo pipefail

REPO="${1:?usage: runner-install.sh owner/repo}"
SLUG="${REPO//\//-}"
BASE="${RUNNER_HOME:-$HOME/.cache/router-runner}"
DIR="$BASE/$SLUG"
TARBALL="$BASE/runner.tar.gz"

mkdir -p "$DIR"
if [ ! -f "$TARBALL" ]; then
  VERSION="$(gh api repos/actions/runner/releases/latest --jq '.tag_name' | sed 's/^v//')"
  curl -fsSL -o "$TARBALL" \
    "https://github.com/actions/runner/releases/download/v${VERSION}/actions-runner-linux-x64-${VERSION}.tar.gz"
fi
[ -x "$DIR/config.sh" ] || tar xzf "$TARBALL" -C "$DIR"

cd "$DIR"
# O token de registro expira em 1h; não é gravado em lugar nenhum.
TOKEN="$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq .token)"
./config.sh --unattended --url "https://github.com/${REPO}" --token "$TOKEN" \
  --name "$(hostname)-${SLUG}" --labels router-ci --replace

# Unidade-modelo de usuário, SEM enable/start: o router liga com ci/runner-up.sh quando abre um PR.
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/router-runner@.service" <<UNIT
[Unit]
Description=GitHub Actions runner for %i, ligado sob demanda

[Service]
WorkingDirectory=$BASE/%i
ExecStart=$BASE/%i/run.sh
Restart=no
UNIT
systemctl --user daemon-reload
echo "runner for ${REPO} registered (stopped). start: ci/runner-up.sh ${SLUG}  stop: ci/runner-down.sh ${SLUG}"
