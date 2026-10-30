# Achados dos CLIs (2026-10-30, tarefa 2)

- `claude -p --output-format json`: texto em `result`, erro em `is_error`, tokens em `usage` (`input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`) e custo real em `total_cost_usd`. Modelo em `modelUsage`.
- `grok -p --output-format json`: texto em `text`, tokens em `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`),
  custo real em `total_cost_usd`. Modelo em `modelUsage` (`grok-4.7-build`).
- Os dois entregam custo pronto: o router registra o valor real e só estima quando o campo faltar.
- `claude --bare` exige API key (login por assinatura falha com "Not logged in"): não serve no modo local.
- Uma sessão trivial do claude já carrega ~85k tokens de contexto (cache write). Isolar com `--setting-sources project
  --strict-mcp-config --disable-slash-commands` não reduziu os tokens. Cada passo/tentativa abre sessão nova, então esse custo
  fixo se repete: vale medir antes de ligar o router em tarefas muito pequenas.
