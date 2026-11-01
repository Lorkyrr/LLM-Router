#!/usr/bin/env python3
"""Hook UserPromptSubmit (Claude Code e Codex): lembra o agente de usar o router.

Leve (só stdlib). Sai sem saída se ROUTER_DEPTH>=1 (processo iniciado pelo router).
"""
import json, os, sys

try:
    if int(os.environ.get("ROUTER_DEPTH") or 0) >= 1:
        sys.exit(0)
except ValueError:
    pass

MSG = ("llm-router ativo: para trabalho de desenvolvimento, oriente-se pelo router MCP "
       "(`route` para classificar, `plan` para planejar, `run_plan` para executar) antes de editar código.")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": MSG}}))
