#!/usr/bin/env bash
# Desfaz o que scripts/install.sh fez. Uso: scripts/uninstall.sh [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$ROOT/scripts/lib/mcp_config.py"
DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) echo "uso: $0 [--dry-run]" >&2; exit 2 ;;
esac
DRYFLAG=()
if [ "$DRY" = 1 ]; then DRYFLAG=(--dry-run); fi
command -v python3 >/dev/null 2>&1 || { echo "falta python3" >&2; exit 1; }

for kind in $(python3 "$HELPER" kinds); do
  python3 "$HELPER" revert --kind "$kind" "${DRYFLAG[@]}"
done

# node_modules só é removido se o instalador o criou.
if [ -n "$(python3 "$HELPER" manifest-get --key npm_ci)" ]; then
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] remover $ROOT/node_modules"
  else
    rm -rf "$ROOT/node_modules"
    python3 "$HELPER" manifest-del --key npm_ci
  fi
fi
echo "ok"
