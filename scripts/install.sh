#!/usr/bin/env bash
# Instalador idempotente do MCP llm-router. Uso: scripts/install.sh [--dry-run]
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

fail=0
need() { command -v "$1" >/dev/null 2>&1 || { echo "falta dependência: $1" >&2; fail=1; }; }
need node; need npm; need git; need python3
command -v gh >/dev/null 2>&1 || echo "aviso: gh ausente (opcional)"
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 24 ]; then echo "node >= 24 necessário (atual: $(node -v))" >&2; fail=1; fi
fi
if [ "$fail" != 0 ]; then exit 1; fi

# npm ci só roda se node_modules estiver ausente ou defasado em relação ao lockfile.
cd "$ROOT"
if [ -f node_modules/.package-lock.json ] && [ ! package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "npm ci: dependências em dia, pulando"
elif [ "$DRY" = 1 ]; then
  echo "[dry-run] npm ci"
else
  if [ ! -d node_modules ] && [ -z "$(python3 "$HELPER" manifest-get --key npm_ci)" ]; then
    python3 "$HELPER" manifest-set --key npm_ci --value '"created-node_modules"'
  fi
  npm ci
fi

# Detecta CLIs presentes. grok: formato de registro MCP não verificado, não é alterado.
found=0
for kind in claude codex gemini copilot cursor-agent opencode goose qwen; do
  command -v "$kind" >/dev/null 2>&1 || continue
  found=1
  python3 "$HELPER" apply --kind "$kind" "${DRYFLAG[@]}" python3 "$ROOT/bin/router-mcp.py"
  python3 "$HELPER" guide-apply --kind "$kind" "${DRYFLAG[@]}"
done
if command -v grok >/dev/null 2>&1; then
  found=1
  echo "grok: detectado, sem formato de registro MCP verificado; pulado"
fi
if [ "$found" = 0 ]; then echo "nenhum CLI de agente encontrado; nada registrado"; fi
echo "ok"
