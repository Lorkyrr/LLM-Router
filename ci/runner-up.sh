#!/usr/bin/env bash
# Liga o runner de um repositório sob demanda (fica desligado para não ocupar RAM). Uso: runner-up.sh owner-repo
set -euo pipefail
systemctl --user start "router-runner@${1:?usage: runner-up.sh owner-repo}.service"
