# Plugins, extensões e registro MCP nos agentes

Consulta: **2026-11-01 (UTC)**. Fontes oficiais consultadas na web; comandos são referências, não instalações executadas. **Proposta** indica desenho futuro; **não confirmado** indica lacuna nas fontes, não ausência garantida do recurso.

## Contrato comum do LLM-Router

MCP conecta ferramentas a um cliente; plugins podem empacotar MCP, skills, agentes e hooks. Registrar MCP não instala automaticamente Node, Python ou dependências do router. Preferir registro stdio direto para esta instalação local.
Nos exemplos, substituir `/ABS/router`, `/ABS/node` e `/ABS/python3` por caminhos absolutos existentes. O comando efetivo é `python3 bin/router-mcp.py --node <node>`; o launcher resolve os arquivos da instalação, preservando o diretório do projeto atendido.
**Evidência local:** [launcher](../../bin/router-mcp.py), [inicialização](../../src/main.ts), [teste de handshake](../../src/mcp-launch.test.ts) e [package.json](../../package.json). O projeto exige Node >=24; **>=26 é política proposta para o instalador**, sem alterar código.
Definir `ROUTER_CHECK_MODELS=manual` evita sondagens automáticas pagas; não desabilita chamadas de modelo que alguém solicitar depois.

## Claude Code

- **Config:** JSON, mapa `mcpServers`; projeto em `.mcp.json`; escopos `user` e `local` em `~/.claude.json` (local dentro da entrada do projeto). Não confundir com `.claude/settings.local.json`. [MCP oficial](https://code.claude.com/docs/en/mcp).
- **Registro oficial**, para todos os projetos do usuário:

```sh
claude mcp add --transport stdio --scope user --env ROUTER_CHECK_MODELS=manual llm-router -- /ABS/python3 /ABS/router/bin/router-mcp.py --node /ABS/node
```

- **Formato de projeto equivalente:** `{"mcpServers":{"llm-router":{"type":"stdio","command":"/ABS/python3","args":["/ABS/router/bin/router-mcp.py","--node","/ABS/node"],"env":{"ROUTER_CHECK_MODELS":"manual"}}}}`.
- **Plugin:** `.claude-plugin/plugin.json`, por exemplo `{"name":"llm-router","version":"0.1.0","mcpServers":"./.mcp.json"}`; `.mcp.json` fica na raiz do plugin. Também há descoberta por layout padrão, sem manifesto. [Manifesto](https://code.claude.com/docs/en/plugins-reference).
- **Verificar:** `claude mcp list`, `claude mcp get llm-router` e `/mcp` na sessão; checar conexão e ferramentas. Para pacote: `claude plugin validate /ABS/plugin`, carregar com `claude --plugin-dir /ABS/plugin` e inspecionar `/plugin`. Listagem de config sozinha não prova handshake. [CLI](https://code.claude.com/docs/en/cli-reference), [manifesto e validação](https://code.claude.com/docs/en/plugins-reference).

## Codex CLI

- **Config:** `~/.codex/config.toml`, TOML com `[mcp_servers.llm-router]`, `command`, `args` e tabela `env`. [Referência CLI](https://developers.openai.com/codex/cli/reference).
- **Registro oficial:**

```sh
codex mcp add llm-router --env ROUTER_CHECK_MODELS=manual -- /ABS/python3 /ABS/router/bin/router-mcp.py --node /ABS/node
```

```toml
[mcp_servers.llm-router]
command = "/ABS/python3"
args = ["/ABS/router/bin/router-mcp.py", "--node", "/ABS/node"]
[mcp_servers.llm-router.env]
ROUTER_CHECK_MODELS = "manual"
```

- **Plugin:** documentação atual recomenda `plugin.json` portátil na raiz (schema Agent Plugins, `name`, `version`, `description`) e `mcp.json` com transporte explícito. `.codex-plugin/plugin.json` + `.mcp.json` continuam como compatibilidade; neste formato, `{"name":"llm-router","version":"0.1.0","mcpServers":"./.mcp.json"}` referencia o mapa `mcpServers`. Não basta renomear arquivos entre formatos. [Empacotamento oficial](https://developers.openai.com/plugins/build/plugins).
- **Verificar:** `codex mcp list`, `codex mcp get llm-router --json`, `/mcp` na TUI e handshake separado. O registro MCP dispensa marketplace/plugin. [MCP](https://developers.openai.com/codex/mcp).

## Grok Build CLI

- **Config:** `~/.grok/config.toml` ou `.grok/config.toml`, tabela `[mcp_servers.llm-router]` com `command`, `args`, `env`, `enabled`; o bloco TOML acima também ilustra esse formato. Há importação de configurações Claude/Cursor/`.mcp.json`, com precedência própria: detectar duplicatas antes de registrar. [Guia oficial MCP](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md).
- **Registro oficial** (padrão `user`; `--scope project` escolhe projeto):

```sh
grok mcp add llm-router -e ROUTER_CHECK_MODELS=manual -- /ABS/python3 /ABS/router/bin/router-mcp.py --node /ABS/node
```

- **Plugin:** diretório com `.mcp.json`, `skills/`, `agents/`, hooks e `plugin.json` opcional para metadados/paths. O catálogo é `.grok-plugin/marketplace.json`; aceita layouts compatíveis Claude. Instalação documentada: `grok plugin install <fonte> --trust`; confiança é uma decisão explícita, não flag a acrescentar silenciosamente pelo instalador. [Plugins oficiais](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md).
- **Verificar:** `grok mcp list --json`, `grok mcp doctor llm-router`, `/mcps`; pacote com `grok plugin list`, `grok plugin details <nome>` e `grok inspect --json`. Recarregar plugins ou iniciar nova sessão. [MCP](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md), [plugins](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md).

## Antigravity e Gemini CLI: clientes distintos

- **Antigravity atual:** global `~/.gemini/config/mcp_config.json`, workspace `.agents/mcp_config.json`; JSON `mcpServers` com `command`, `args`, `env`, como o exemplo Claude sem necessidade de `type`. CLI `agy`: `/mcp` abre o gerenciador e mostra status/logs/reload; IDE: MCP Servers → Manage MCP Servers → View raw config. Esses são os meios de registro confirmados. **Sintaxe shell `agy mcp add` não confirmada nas referências consultadas**; usar edição estruturada ou UI. [MCP oficial](https://antigravity.google/docs/mcp), [referência CLI](https://antigravity.google/docs/cli/reference/).
- **Plugin Antigravity:** `plugin.json` na raiz ou `.antigravity-plugin/plugin.json`, com `name`, `version`, `description` e schema `https://antigravity.google/schemas/v1/plugin.json`; servidores em `mcp_config.json` na raiz. `agy plugin validate --strict /ABS/plugin`, `agy plugin install /ABS/plugin`, `agy plugin list`; confirmar MCP também em `/mcp`. Não assumir caminhos antigos `.gemini/antigravity/`. [Construir plugins](https://antigravity.google/docs/build-plugins/).
- **Gemini CLI:** `~/.gemini/settings.json` (user) ou `.gemini/settings.json` (project), JSON `mcpServers` com `command`, `args`, `env`. [MCP oficial](https://geminicli.com/docs/tools/mcp-server/).

```sh
gemini mcp add --scope user --transport stdio -e ROUTER_CHECK_MODELS=manual llm-router /ABS/python3 /ABS/router/bin/router-mcp.py -- --node /ABS/node
```

- **Extensão Gemini:** `~/.gemini/extensions/<extensão>/gemini-extension.json`, por exemplo `{"name":"llm-router","version":"0.1.0","mcpServers":{"llm-router":{"command":"/ABS/python3","args":["/ABS/router/bin/router-mcp.py","--node","/ABS/node"]}}}`. Instalar com `gemini extensions install /ABS/extensao`; verificar `gemini extensions list`, `/extensions list`, `gemini mcp list` e `/mcp`; reiniciar sessão após instalar. [Referência de extensões](https://geminicli.com/docs/extensions/reference/).

## Zed

- **Config:** settings JSON/JSONC; normalmente `~/.config/zed/settings.json` em Linux/macOS, respeitando `XDG_CONFIG_HOME` no Linux; projeto `.zed/settings.json`. Confirmar o arquivo ativo pela UI. [Configuração no repositório oficial](https://github.com/zed-industries/zed/blob/main/docs/.doc-examples/configuration.md).
- **Registro oficial:** Settings → AI → MCP Servers → Add Server, ou editar `context_servers` com o formato abaixo. **Subcomando shell `zed mcp add` não confirmado.** [MCP no Zed](https://zed.dev/docs/ai/mcp).

```json
{"context_servers":{"llm-router":{"command":"/ABS/python3","args":["/ABS/router/bin/router-mcp.py","--node","/ABS/node"],"env":{"ROUTER_CHECK_MODELS":"manual"}}}}
```

- **Extensão:** `extension.toml` com metadados e `[context_servers.llm-router]`; implementação Rust/Wasm de `context_server_command` devolve comando/args/env. A documentação anuncia migração futura dessas extensões para o registro MCP oficial; para uso local, preferir settings. [MCP Server Extensions](https://zed.dev/docs/extensions/mcp-extensions).
- **Verificar:** indicador verde e tooltip “Server is active” em Settings → AI → MCP Servers; habilitar ferramentas no perfil. ACP pode encaminhar MCP a agentes externos, que também têm configs próprias; conferir logs com `dev: open acp logs` e evitar registro duplicado. [MCP](https://zed.dev/docs/ai/mcp), [agentes externos](https://zed.dev/docs/ai/external-agents).

## Desenho do instalador idempotente — proposta, não implementado

Interface sugerida: `install-router [--agents auto|claude,codex,grok,gemini,agy,zed] [--scope user|project] [--dry-run|--check-only]`. Padrão: `auto` e `user`; lista explícita permite instalar CLIs ainda ausentes, sem instalar todos os agentes por acidente.

1. **Inventário:** detectar SO/arquitetura, executáveis por `PATH` e locais oficiais, versões com timeout e instalações gráficas/configs existentes. Validar capacidades em `--help`; não equiparar binário homônimo a CLI oficial. Resolver caminhos absolutos; registrar versão e URL de cada receita.
2. **Dependências:** validar Node major >=26, npm, `python3 --version`, `git --version`, `gh --version`; comparar lockfile e instalação npm (`npm ls --depth=0`), incluindo `tsx`. Persistir hash do lockfile + versão Node/ABI apenas após sucesso; `npm ci` somente quando ausente/inconsistente. Nunca usar `npm start` como diagnóstico, pois a inicialização padrão pode chamar modelos.
3. **Instalar faltantes:** usar binário Node oficial com versão fixada/checksum e prefixo privado; Python/Git/gh por gerenciador suportado do SO, verificando novamente. Se não houver permissão/receita, retornar pendência precisa. Fontes: [Node](https://nodejs.org/en/download), [Python](https://www.python.org/downloads/), [Git](https://git-scm.com/downloads), [gh](https://cli.github.com/), [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci).
4. **CLIs selecionadas:** receitas oficiais, prefixo de usuário: Claude via instalador nativo, Codex instalador `https://chatgpt.com/codex/install.sh`, Gemini `npm install -g @google/gemini-cli@<versão>`, Grok instalador `https://x.ai/cli/install.sh`, Antigravity `https://antigravity.google/cli/install.sh`. Fixar versões quando a distribuição permitir; não inventar flags de versão dos instaladores. Baixar/inspecionar antes de executar, registrar versão resultante e não atualizar instalação compatível numa segunda execução; Zed/IDE por distribuição oficial do SO. [Claude](https://code.claude.com/docs/en/quickstart), [Codex](https://developers.openai.com/codex/cli), [Gemini](https://geminicli.com/docs/get-started/installation/), [Grok](https://x.ai/build), [Antigravity](https://antigravity.google/docs/getting-started/), [Zed](https://zed.dev/download).
5. **Login:** `claude auth status`, `codex login status`, `gh auth status`; se necessário, encaminhar aos fluxos `claude auth login`, `codex login`, `gh auth login`. Grok documenta `grok login`; Gemini autentica no fluxo interativo; Antigravity na primeira execução. **Status headless uniforme para Grok/Gemini/Antigravity não confirmado**: marcar `requer validação interativa`, sem chamar modelo ou imprimir credenciais. Zed e agentes ACP podem autenticar separadamente. [Claude](https://code.claude.com/docs/en/cli-reference), [Codex](https://developers.openai.com/codex/cli/reference), [gh](https://cli.github.com/manual/gh_auth_status), [Grok](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md), [Gemini](https://geminicli.com/docs/get-started/authentication/), [Antigravity](https://antigravity.google/docs/getting-started/).
6. **Convergência:** ler config efetiva e escopos/importações; se `llm-router` já corresponde a comando/args/env, não escrever. Nome existente com destino diferente exige resolução explícita. Preferir CLI oficial quando houver; editar JSONC/TOML com parser que preserve comentários/chaves alheias, lock, backup privado, validação e troca atômica. Não adicionar parser como dependência deste projeto nesta pesquisa.
7. **Registro:** aplicar comandos/formatos acima; `command` é Python absoluto, `args` contém launcher e Node absolutos, sem expansão dependente de shell. Incluir `ROUTER_CHECK_MODELS=manual`. Não fixar `cwd` na instalação: o router atende o projeto aberto. Preservar sandbox, políticas gerenciadas e decisões de confiança; evitar MCP recursivo nos agentes filhos.
8. **Handshake real:** iniciar launcher por pipes usando `StdioClientTransport` e `Client` do SDK já instalado, `ROUTER_CHECK_MODELS=manual`, `ROUTER_VERIFY_MODE=local` e `ROUTER_DB` temporário privado; `client.connect()` negocia, depois `listTools()` deve conter `route`/`run_plan`, e `status` deve responder sem erro. Não chamar `route`, `run_plan` ou sondagens pagas.
9. **Compatibilidade e saída:** o teste local usa a negociação `initialize` → resposta → `notifications/initialized`; não enviar apenas `tools/list`. A especificação atual distingue a era moderna e clientes legados: usar a negociação suportada pelo SDK fixado e reportar versão, sem prometer compatibilidade universal. Impor timeout, fechar cliente/pipes, aguardar saída e encerrar grupo descendente em falha. [Ciclo legado](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle), [compatibilidade atual](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).
10. **Aceitação no cliente:** depois do handshake independente, usar listagem/doctor/status do cliente e confirmar ferramentas carregadas; GUI pendente deve aparecer como pendente, não sucesso. Reexecutar duas vezes: segunda execução sem diff/instalações; testar também config conflitante, runtime antigo, login ausente e falha de handshake.

**Modos:** `--dry-run` faz somente leituras e mostra plano/diff redigido; não instala, escreve configs, inicia router nem login. `--check-only` não repara nem altera configs; permite diagnóstico/handshake com estado temporário descartável, nunca inferência paga. Podem existir logs próprios dos CLIs; não prometer ausência absoluta de escrita. Flags mutuamente exclusivas; códigos propostos: `0` conforme, `2` pendências/conflitos, `1` erro operacional. Relatório separa runtime, login, registro, transporte e carga no cliente.

**Limites:** este documento não instala dependências nem comprova login/carga em todos os clientes. Handshake do router não prova acesso a modelos. Recursos dependem da versão instalada; comandos não encontrados em versões antigas devem produzir pendência, sem flags inventadas.
