#!/usr/bin/env bash
# Liga o runner self-hosted sob demanda (ele fica desligado para não ocupar RAM).
set -euo pipefail
systemctl --user start router-runner.service
