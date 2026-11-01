# Adapters automáticos e roteamento implícito — LLM Router

> **Status: PLANEJADO (não implementado).** Pesquisa feita em 2026-11-01.
> Legenda: ✅ confirmado nesta pesquisa em fonte oficial · 📘 com base na doc oficial citada, não reverificada hoje · ❓ não confirmado.

## 1. CLIs de agentes de IA com suporte a MCP (como cliente)

| CLI | Binário | Headless / não-interativo | Registrar servidor MCP stdio | Modelos / provedores | Hook a cada mensagem do usuário | Fontes |
|---|---|---|---|---|---|---|
| **Claude Code** | `claude` | `claude -p "..." --output-format json\|stream-json` 📘 | `claude mcp add <nome> -- <cmd> [args]` (`--scope user\|project\|local`); `~/.claude.json` e `.mcp.json` no projeto 📘 | Claude (Anthropic API, Bedrock, Vertex) 📘 | **Sim**: `UserPromptSubmit` em `~/.claude/settings.json` / `.claude/settings.json`; stdout vira contexto 📘 | https://docs.anthropic.com/en/docs/claude-code/mcp · https://docs.anthropic.com/en/docs/claude-code/hooks · https://docs.anthropic.com/en/docs/claude-code/cli-reference |
| **OpenAI Codex CLI** | `codex` | `codex exec "..."` (`--json`) 📘 | `codex mcp add <nome> -- <cmd>` ou `[mcp_servers.<nome>]` em `~/.codex/config.toml` 📘 | Modelos OpenAI; provedores customizáveis via `model_providers` 📘 | **Sim** ✅: `UserPromptSubmit` em `~/.codex/hooks.json`, `<repo>/.codex/hooks.json` ou `[hooks]` no `config.toml`; stdout/`additionalContext` vira contexto de developer; hooks precisam ser “trusted” via `/hooks`; falha = fail-open | https://developers.openai.com/codex/hooks · https://developers.openai.com/codex/mcp · https://github.com/openai/codex/pull/14626 |
| **Gemini CLI** | `gemini` | `gemini -p "..."` (`--output-format json`) 📘 | `gemini mcp add <nome> <cmd> [args]` ou `mcpServers` em `~/.gemini/settings.json` / `.gemini/settings.json` 📘 | Gemini (Google AI Studio key, Vertex, login Google) 📘 | Sim, hooks (evento `BeforeAgent` roda após o prompt do usuário) 📘 — nome exato do evento ❓ reverificar | https://geminicli.com/docs/tools/mcp-server/ · https://geminicli.com/docs/hooks/ |
| **Grok Build CLI** | `grok` | ✅ `grok -p "..." --output-format json\|streaming-json --max-turns N`; `grok agent stdio` (ACP) | ✅ `grok mcp add <nome> -- <cmd> [args]` (`--scope project`) ou `[mcp_servers.<nome>]` em `~/.grok/config.toml` / `.grok/config.toml`; também lê `~/.claude.json`, `.cursor/mcp.json`, `.mcp.json` | ✅ `grok models`; `-m <modelo>`; modelos xAI (custom models via config) | Hooks existem (`grok inspect` lista hooks) ✅; evento por prompt do usuário ❓ não confirmado | https://docs.x.ai/build/cli/reference · https://docs.x.ai/build/settings/reference · https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md |
| **GitHub Copilot CLI** | `copilot` | `copilot -p "..."` (`--allow-all-tools`) 📘 | ✅ `copilot mcp add` → `~/.copilot/mcp-config.json` (`"type":"local"`); projeto: `.mcp.json` / `.github/mcp.json` | Multi-modelo via assinatura Copilot (Claude, GPT, Gemini…) 📘 | **Parcial** ✅: `userPromptSubmitted` roda a cada prompt mas **output é ignorado** (só efeito colateral, não injeta contexto). Hooks em `~/.copilot/hooks/`, `settings.json` ou `.github/hooks/` | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers · https://docs.github.com/en/copilot/reference/hooks-reference · https://docs.github.com/en/copilot/tutorials/copilot-cli-hooks |
| **Cursor CLI** | `cursor-agent` / `agent` | `cursor-agent -p "..." --output-format json` 📘 | `mcpServers` em `~/.cursor/mcp.json` / `.cursor/mcp.json` 📘; `/mcp enable\|disable` ✅ | Multi-provedor via conta Cursor (Anthropic, OpenAI, Google, xAI…) 📘 | **Sim, com ressalva** ✅: `beforeSubmitPrompt` em `~/.cursor/hooks.json` / `.cursor/hooks.json` (pode bloquear; não reescreve texto). **Não dispara em `-p/--print`**. CLI também é compatível com hooks do Claude Code | https://cursor.com/docs/hooks · https://cursor.com/changelog/2-4 · https://forum.cursor.com/t/cursor-cli-does-not-run-enterprise-or-team-beforesubmitprompt-hooks/173219 · https://cursor.com/docs/cli/mcp |
| **Amp** | `amp` | `amp -x "..."` (execute mode) 📘 | `amp.mcpServers` em `~/.config/amp/settings.json` 📘; `amp mcp add` ❓ | Modelos escolhidos pela Amp (Claude, GPT etc.) 📘 | ❓ não confirmado | https://ampcode.com/manual |
| **OpenCode** | `opencode` | `opencode run "..."` 📘 | `"mcp": {"<nome>": {"type":"local","command":[...]}}` em `~/.config/opencode/opencode.json` / `opencode.json` 📘 | 75+ provedores via AI SDK/Models.dev 📘 | Plugins JS/TS com eventos (ex.: `chat.message`) 📘 — semântica exata ❓ | https://opencode.ai/docs/mcp-servers/ · https://opencode.ai/docs/plugins/ · https://opencode.ai/docs/cli/ |
| **Goose** | `goose` | `goose run -t "..."` 📘 | Extensões MCP via `goose configure` ou `extensions:` em `~/.config/goose/config.yaml` (`type: stdio`) 📘 | Multi-provedor (OpenAI, Anthropic, Google, Ollama, OpenRouter…) 📘 | ❓ não confirmado | https://block.github.io/goose/docs/getting-started/using-extensions |
| **Aider** | `aider` | `aider --message "..." --yes` 📘 | ❓ **Sem suporte MCP nativo confirmado** na doc oficial | Multi-provedor via LiteLLM 📘 | Não (só git hooks/lint) ❓ | https://aider.chat/docs/ · https://github.com/Aider-AI/aider/issues |
| **Qwen Code** | `qwen` | `qwen -p "..."` 📘 (fork do Gemini CLI) | `mcpServers` em `~/.qwen/settings.json`; `qwen mcp add` 📘 | Qwen (OAuth Qwen, DashScope) + APIs OpenAI-compatíveis 📘 | ❓ não confirmado | https://qwenlm.github.io/qwen-code-docs/ |
| **Kiro CLI** | `kiro-cli` (antigo `q`) | `kiro-cli chat --no-interactive "..."` 📘 | `mcpServers` em `~/.kiro/settings/mcp.json` / `.kiro/settings/mcp.json`; `kiro-cli mcp add` 📘 | Claude via AWS 📘 | Hooks de agente incl. `userPromptSubmit` 📘 (herdado do Amazon Q CLI) — reverificar | https://kiro.dev/docs/cli/mcp/ · https://kiro.dev/docs/cli/hooks/ |
| **Crush** (Charm) | `crush` | `crush run "..."` 📘 | `"mcp": {"<nome>": {"type":"stdio","command":...}}` em `crush.json` / `~/.config/crush/crush.json` 📘 | Multi-provedor (OpenAI, Anthropic, Gemini, OpenRouter, locais) 📘 | ❓ não confirmado | https://github.com/charmbracelet/crush |
| **Continue CLI** | `cn` | `cn -p "..."` 📘 | `mcpServers:` em `~/.continue/config.yaml` ou blocos em `.continue/mcpServers/` 📘 | Multi-provedor 📘 | ❓ não confirmado | https://docs.continue.dev/guides/cli · https://docs.continue.dev/customize/deep-dives/mcp |
| **Cline CLI** | `cline` | modo headless/`-y` 📘 ❓ flags exatas | Config MCP do Cline (`cline_mcp_settings.json`) ❓ caminho na CLI | Multi-provedor 📘 | Hooks do Cline (`UserPromptSubmit`) 📘 ❓ reverificar na CLI | https://docs.cline.bot/cline-cli/overview · https://docs.cline.bot/features/hooks |

**Observação:** itens 📘/❓ devem ser revalidados antes da implementação de cada adapter (as CLIs mudam rápido).

## 2. Plano: adapters automáticos

**Decisão do usuário:** o router terá um adapter para **cada CLI listada acima**. Na instalação/primeira execução ele **detecta quais binários existem na máquina** e só instala/configura o MCP e o adapter para os presentes — **nada é baixado** para CLIs ausentes.

### Fluxo
1. `router setup` (ou primeira execução) percorre o registro de adapters.
2. Para cada um: `command -v <bin>` → se existe, `<bin> --version` (timeout 5 s) e grava em `~/.config/llm-router/detected.json` (`bin`, caminho, versão, data).
3. Para os presentes: registra o servidor MCP `llm-router` (stdio) preferindo o comando oficial `mcp add` (idempotente, valida formato); senão, faz merge no arquivo de config com **backup** (`*.bak-<timestamp>`) e sem sobrescrever outras chaves.
4. Opcional (opt-in): instala hook de prompt / instrução global (seção 3).
5. `router doctor` re-detecta; `router uninstall` remove apenas as entradas que o router criou (marcadas com `llm-router`).

### Detecção e destino por CLI
| CLI | Detecção | Onde escrever |
|---|---|---|
| Claude Code | `command -v claude` | `claude mcp add --scope user llm-router -- llm-router mcp` |
| Codex | `command -v codex` | `codex mcp add llm-router -- llm-router mcp` / `~/.codex/config.toml` |
| Gemini CLI | `command -v gemini` | `gemini mcp add` / `~/.gemini/settings.json` |
| Grok Build | `command -v grok` | `grok mcp add llm-router -- llm-router mcp` / `~/.grok/config.toml` |
| Copilot CLI | `command -v copilot` | `copilot mcp add` / `~/.copilot/mcp-config.json` |
| Cursor CLI | `command -v cursor-agent \|\| command -v agent` (confirmar que `agent` é o Cursor via `--version`) | `~/.cursor/mcp.json` |
| Amp | `command -v amp` | `~/.config/amp/settings.json` (`amp.mcpServers`) |
| OpenCode | `command -v opencode` | `~/.config/opencode/opencode.json` (`mcp`) |
| Goose | `command -v goose` | `~/.config/goose/config.yaml` (`extensions`) |
| Qwen Code | `command -v qwen` | `~/.qwen/settings.json` |
| Kiro CLI | `command -v kiro-cli` | `~/.kiro/settings/mcp.json` |
| Crush | `command -v crush` | `~/.config/crush/crush.json` |
| Continue CLI | `command -v cn` | `~/.continue/config.yaml` |
| Cline CLI | `command -v cline` | caminho ❓ a confirmar |
| Aider | `command -v aider` | sem MCP: adapter só como **alvo** (invocado pelo router via `aider --message`), não como cliente |

Cada adapter expõe: `detect()`, `version()`, `install_mcp()`, `install_hook()`, `invoke(prompt, cwd)` (modo headless da tabela) e `uninstall()`.

## 3. Plano: roteamento implícito

**Decisão do usuário:** depois de instalado, o router **não precisa ser chamado num agente específico nem por um comando específico**. Ele lê **toda mensagem** que o usuário envia a qualquer modelo/agente, identifica as pendências nela e invoca os agentes responsáveis.

### Mecanismos (do mais forte ao mais fraco)
1. **Hook de prompt** (determinístico, roda sempre): o hook chama `llm-router analyze --stdin`, que extrai pendências e (a) dispara agentes responsáveis em background e/ou (b) devolve contexto ("pendências X, Y encaminhadas para A, B").
   - Claude Code `UserPromptSubmit`; Codex `UserPromptSubmit` (injeta `additionalContext`; exige trust via `/hooks`); Gemini CLI hooks; Kiro/Cline hooks (a confirmar); Cursor `beforeSubmitPrompt` (só bloqueia/permite, **não** injeta contexto, **não roda em `-p`**); Copilot `userPromptSubmitted` (**output ignorado** → só disparo em background).
2. **Instrução global** (probabilística, depende do modelo obedecer): `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `AGENTS.md`/rules nas demais, mandando "a cada mensagem do usuário, chame a tool MCP `route` com o texto".
   - Usado onde não há hook (Amp, Goose, Crush, Continue, Qwen, Grok enquanto o evento não for confirmado).
3. **Plugin** (OpenCode plugins, plugins do Grok/Codex) quando houver evento por mensagem.
4. **Wrapper de shell** (fallback): função/alias que intercepta `claude -p`, `codex exec` etc. e passa o prompt pelo router antes. Só cobre o modo headless; no TUI não vê mensagens subsequentes.

### Limitações por ferramenta
- Copilot: hook não altera o prompt nem o contexto.
- Cursor: sem hook em `--print`; hook não reescreve prompt.
- Codex: hooks fail-open e precisam aprovação manual do hash.
- Aider: sem MCP — só como destino.
- CLIs com ❓: começar por instrução global e promover para hook quando confirmado.

### Riscos e mitigações
- **Recursão/loop:** o router invoca um agente que também tem o hook → hook chama router de novo. Guarda: env var `ROUTER_DEPTH` (o router exporta `ROUTER_DEPTH=$((ROUTER_DEPTH+1))` ao invocar; hook sai imediatamente se `ROUTER_DEPTH>=1`, limite máximo configurável), mais `ROUTER_INVOCATION_ID` para deduplicar e um lock por sessão.
- **Custo:** cada mensagem gera uma análise. Usar classificador local/barato primeiro (regex/heurística/modelo pequeno), só chamar LLM quando houver pendência provável; orçamento diário e `router pause`.
- **Latência:** hook síncrono atrasa o prompt → timeout curto (≤2 s) e trabalho pesado em background.
- **Privacidade:** o router lê todas as mensagens. Processar localmente por padrão, não logar texto bruto (só hashes/metadados), redigir segredos, opt-in explícito por CLI e lista de diretórios excluídos.
- **Ações indevidas:** pendências detectadas não executam ações irreversíveis sem confirmação; modo "sugerir" como padrão.
- **Conflito de configs:** merges com backup e marcação; `router uninstall` reverte.

**Status:** planejado — nada disto está implementado.
