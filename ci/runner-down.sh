#!/usr/bin/env bash
set -euo pipefail
systemctl --user stop "router-runner@${1:?usage: runner-down.sh owner-repo}.service"
