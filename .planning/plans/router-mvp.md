# Plan: router-mvp

**Spec**: .planning/specs/router-mvp.md
**Epic**: none
**Created**: 2026-10-30
**Status**: implemented (MVP merged, ver "Estado" no fim do plano)

## Stack e decisões

- **TypeScript em Node 24**, rodando `.ts` direto (type stripping nativo), sem etapa de build.
- **SQLite via `node:sqlite`** (embutido no Node 24): sem dependência nativa.
- **Testes com `node:test`** (embutido).
- **Dependências:** só `@modelcontextprotocol/sdk`, `zod` (exigido pelo SDK) e `yaml`.
- As regras globais de Kotlin/Micronaut/Postgres do `~/.claude` **não se aplicam** a este projeto. A ideia das camadas se mantém: ferramenta MCP (fina) → orquestração → store (SQLite) / adapters (CLIs externos).
- Toda chamada a processo externo (`claude`, `grok`, `gh`, `git`) passa por um `exec` injetável, para os testes rodarem com fakes, sem gastar tokens.
- **Primeiro repositório-alvo é o próprio LLM-Router** (dogfooding): os workflows de CI ficam aqui e depois são copiados para outros repositórios.

Flags verificadas neste PC: `claude -p --model --effort --output-format json`; `grok -m --reasoning-effort -p --output-format json`. `gh` 2.46, `kind` 0.33, Docker 29 e Node 24.19 instalados; `pnpm` não (usar npm).

## Arquitetura

### Componentes

| Componente | Camada | Função |
|---|---|---|
| `server.ts` | MCP (fina) | Registra `route`, `plan`, `run_plan`, `status`, `check_models`, `relay`; só valida e delega |
| `config.ts` | Config | Lê e valida `router.yaml` (um modelo em uma só categoria, preços, escalada) |
| `store/db.ts`, `store/repo.ts` | Store | Schema SQLite e leitura/escrita das 5 tabelas |
| `policy/select.ts` | Lógica pura | Escolhe o modelo da categoria por preferência e disponibilidade; nunca desce de categoria |
| `policy/escalate.ts` | Lógica pura | Escada de escalada por categoria e tentativa |
| `policy/cost.ts` | Lógica pura | Custo estimado por uso de tokens e linha de base "tudo no forte" |
| `adapters/*.ts` | Externo | Monta a chamada do CLI e lê a saída JSON (texto, tokens, código de saída) |
| `catalog/check.ts` | Orquestração | Teste de disponibilidade; grava em `models` |
| `triage/triage.ts` | Orquestração | Modelo barato em low → `{ phase, tier }` |
| `planner/planner.ts` | Orquestração | Modelo forte → passos; força sequência quando os arquivos se sobrepõem |
| `git/branch.ts` | Externo | Worktree e branch por passo, push, `gh pr create` |
| `verify/ci.ts` | Externo | Acompanha os checks do PR; se verde, faz rebase, merge e apaga o branch; detecta conflito |
| `runner/run-step.ts` | Orquestração | Laço de tentativas: escolhe → executa → PR → CI → escala ou conclui |
| `runner/run-plan.ts` | Orquestração | Agenda os passos respeitando dependências, em paralelo quando possível |
| `dispatch/dispatch.ts` | Orquestração | Escolhe runner local ou hospedado; redispara passo órfão |
| `channel/relay.ts` | Orquestração | Envia ao grok bot; se falhar, guarda como não entregue (o Claude lê por `status`); reentrega depois |
| `hooks/user-prompt-submit.ts` | Hook | Grava em `messages` o prompt enviado ao claude-code |
| `cli.ts` | Entrada | `node src/cli.ts run --task <id>`, usado pelo workflow de nuvem |
| `main.ts` | Entrada | Sobe o servidor MCP e os ciclos periódicos (disponibilidade, reentrega, órfãos) |

### Arquivos novos

| Arquivo | Local |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore`, `.mcp.json` | raiz |
| `router.yaml` | `config/` |
| `config.ts`, `exec.ts`, `server.ts`, `main.ts`, `cli.ts` | `src/` |
| `db.ts`, `repo.ts` | `src/store/` |
| `select.ts`, `escalate.ts`, `cost.ts` | `src/policy/` |
| `types.ts`, `claude-code.ts`, `grok-build.ts` | `src/adapters/` |
| `check.ts` | `src/catalog/` |
| `triage.ts` | `src/triage/` |
| `planner.ts` | `src/planner/` |
| `branch.ts` | `src/git/` |
| `ci.ts` | `src/verify/` |
| `run-step.ts`, `run-plan.ts` | `src/runner/` |
| `dispatch.ts` | `src/dispatch/` |
| `relay.ts` | `src/channel/` |
| `user-prompt-submit.ts` | `hooks/` |
| `kind-up.sh`, `kind-down.sh` | `ci/` |
| `router-verify.yml`, `router-cloud.yml` | `.github/workflows/` |
| `*.test.ts` | ao lado de cada arquivo |
| `claude-print.json`, `grok-print.json`, `fake-exec.ts` | `test/fixtures/` |
| `bench-triage.ts` | `test/` |
| `grok-bot.md` | `.planning/spikes/` |

### Arquivos a mudar

| Arquivo | O que muda | Por quê |
|---|---|---|
| `ARQUITETURA.md` | `gemini-pro` em uma só categoria; grok bot só como ponte; nota de que zed/antigravity/codex e importadores estão fora do MVP | Alinhar com o spec |

## Tarefas

A coluna **Cat.** indica a categoria que o próprio router usaria para a tarefa: quem executa cada uma.

### Fase 0: Validação (antes de qualquer código)

| # | Tarefa | Arquivos | Cat. |
|---|---|---|---|
| 1 | Spike: o grok bot recebe mensagens externas e chama MCP ou HTTP? Registrar a conclusão e o transporte escolhido (ou "Claude é o canal principal") | `.planning/spikes/grok-bot.md` | forte |
| 2 | Capturar uma saída real de `claude -p --output-format json` e de `grok -p --output-format json` com um prompt mínimo, para usar como fixtures (confirma onde ficam os campos de tokens) | `test/fixtures/claude-print.json`, `test/fixtures/grok-print.json` | barata |

### Fase 1: Base (depende da Fase 0, tarefa 2)

| # | Tarefa | Arquivos | Cat. |
|---|---|---|---|
| 3 | `git init`, repositório no GitHub, `package.json` (scripts `test` e `start`), `tsconfig.json` com `noEmit`, `.gitignore` | `package.json`, `tsconfig.json`, `.gitignore` | barata |
| 4 | `exec` injetável e um fake para testes | `src/exec.ts`, `test/fixtures/fake-exec.ts` | média |
| 5 | `router.yaml` e um loader com zod: um modelo por categoria, preço por modelo, escada de escalada | `config/router.yaml`, `src/config.ts`, `src/config.test.ts` | média |
| 6 | Schema SQLite (5 tabelas, `id` UUID, `created_at` e `updated_at` em UTC) | `src/store/db.ts`, `src/store/db.test.ts` | média |
| 7 | Repo: inserir, ler e atualizar `tasks`/`steps`/`attempts`/`models`/`messages`; somas de custo | `src/store/repo.ts`, `src/store/repo.test.ts` | média |

### Fase 2: Política (lógica pura, depende da tarefa 5)

| # | Tarefa | Arquivos | Cat. |
|---|---|---|---|
| 8 | `select`: preferência + disponibilidade dentro da categoria; `waiting_quota` se nenhum estiver disponível | `src/policy/select.ts`, `src/policy/select.test.ts` | média |
| 9 | `escalate`: barata→média medium→média high; medium→high→xhigh; forte high→xhigh→parar | `src/policy/escalate.ts`, `src/policy/escalate.test.ts` | média |
| 10 | `cost`: custo por tokens (entrada, saída, leitura e escrita de cache) e linha de base "tudo no forte" | `src/policy/cost.ts`, `src/policy/cost.test.ts` | média |

### Fase 3: Adapters (dependem das tarefas 2 e 4)

| # | Tarefa | Arquivos | Cat. |
|---|---|---|---|
| 11 | Tipo `Adapter` (`run({ model, effort, prompt, cwd })` → `{ ok, text, usage }`, `ping(model)`) e o adapter claude-code | `src/adapters/types.ts`, `src/adapters/claude-code.ts`, `src/adapters/claude-code.test.ts` | média |
| 12 | Adapter grok build | `src/adapters/grok-build.ts`, `src/adapters/grok-build.test.ts` | média |
| 13 | `check_models`: ping mínimo por modelo, grava `available`/`quota_state` | `src/catalog/check.ts`, `src/catalog/check.test.ts` | média |

### Fase 4: Núcleo (depende das Fases 1–3)

| # | Tarefa | Arquivos | Cat. |
|---|---|---|---|
| 14 | Triagem: prompt de classificação, saída JSON validada com zod, `override_tier` | `src/triage/triage.ts`, `src/triage/triage.test.ts` | forte (o prompt define a qualidade de tudo) |
| 15 | Benchmark da triagem contra `bench/judge-cases.json` do effortless (esforço low→barata, medium→média, high/xhigh→forte); meta ≥ 90% | `test/bench-triage.ts` | média |
| 16 | Planejador: o forte devolve passos `{ tier, brief, depends_on, files }`; arquivos em comum viram dependência | `src/planner/planner.ts`, `src/planner/planner.test.ts` | forte |
| 17 | Git: worktree e branch por passo, commit, push, `gh pr create` | `src/git/branch.ts`, `src/git/branch.test.ts` | média |
| 18 | Verificação: `gh pr checks --watch`; se verde, `gh pr merge --rebase --delete-branch`; detecta conflito | `src/verify/ci.ts`, `src/verify/ci.test.ts` | média |
| 19 | `run-step`: laço de tentativas com sessão nova a cada tentativa, brief curto, registro em `attempts`, escalada, até 3 tentativas, relato | `src/runner/run-step.ts`, `src/runner/run-step.test.ts` | forte (laço com estado e várias saídas) |
| 20 | `run-plan`: agenda por dependências; passos independentes rodam em paralelo | `src/runner/run-plan.ts`, `src/runner/run-plan.test.ts` | média |

### Fase 5: Canal (depende das tarefas 1 e 7)

| # | Tarefa | Arquivos | Cat. |
|---|---|---|---|
| 21 | `relay`: envia ao grok bot pelo transporte do spike; se falhar, grava `delivered=false` e o fluxo segue; `flush` reentrega um resumo quando o bot volta | `src/channel/relay.ts`, `src/channel/relay.test.ts` | média |
| 22 | Hook `UserPromptSubmit`: grava o prompt em `messages` (sem chamar rede, para não atrasar o claude-code) | `hooks/user-prompt-submit.ts`, `hooks/user-prompt-submit.test.ts` | barata |

### Fase 6: Servidor MCP (depende das Fases 4 e 5)

| # | Tarefa | Arquivos | Cat. |
|---|---|---|---|
| 23 | `server.ts` com as 6 ferramentas e esquemas zod em snake_case | `src/server.ts`, `src/server.test.ts` | média |
| 24 | `main.ts` (stdio + ciclos periódicos) e `.mcp.json` para registrar no claude-code | `src/main.ts`, `.mcp.json` | média |

### Fase 7: CI e despacho (depende das tarefas 17 e 18)

| # | Tarefa | Arquivos | Cat. |
|---|---|---|---|
| 25 | Scripts do kind e workflow self-hosted (`runs-on: self-hosted`): kind up → `npm test` → kind down (`if: always()`) | `ci/kind-up.sh`, `ci/kind-down.sh`, `.github/workflows/router-verify.yml` | média |
| 26 | Workflow de nuvem (`workflow_dispatch`, runner hospedado, API keys nos Secrets, categorias barata e média) e `cli.ts run --task` | `.github/workflows/router-cloud.yml`, `src/cli.ts` | média |
| 27 | `dispatch`: runner self-hosted online (`gh api .../actions/runners`)? local : nuvem; heartbeat expirado → redispara no hospedado | `src/dispatch/dispatch.ts`, `src/dispatch/dispatch.test.ts` | média |
| 28 | Alinhar o `ARQUITETURA.md` com o spec | `ARQUITETURA.md` | barata |

### Paralelo e sequencial

| Grupo paralelo | Tarefas | Por quê |
|---|---|---|
| A | 1, 2 | Spike e fixtures são independentes |
| B | 6, 5 | Schema e config não se tocam |
| C | 8, 9, 10 | Funções puras em arquivos separados |
| D | 11 → 12 (o 12 usa o tipo do 11), 13 depois | — |
| E | 17, 18, 21, 22 | Git, verificação e canal são independentes entre si |
| F | 25, 26, 28 | Arquivos de CI e docs |

| Sequencial | Depende de | Por quê |
|---|---|---|
| 3 | 2 | Fixtures entram no primeiro commit |
| 7 | 6 | Repo usa o schema |
| 14, 16 | 11, 12, 8 | Chamam adapters via `select` |
| 15 | 14 | Mede a triagem |
| 19 | 7, 9, 10, 11, 17, 18 | Junta tudo |
| 20 | 19 | Agenda `run-step` |
| 23 | 13, 14, 16, 20, 21 | Expõe as ferramentas |
| 24 | 23 | Sobe o servidor |
| 27 | 25, 26 | Escolhe entre os dois workflows |

## Plano de testes

Todos os testes usam o `fake-exec` e um SQLite em memória; nenhum gasta tokens. A exceção é o `bench-triage`, rodado manualmente.

| Camada | Testes | Requisito / caso do spec |
|---|---|---|
| Store | inserir e ler cada tabela; `updated_at` muda no update; somas de custo por categoria; nada é apagado (sem soft delete, o fim é o `status`) | Data Model; história 5 |
| Config | rejeita modelo em duas categorias; rejeita categoria vazia; carrega os preços | Regra 1 da política |
| Política | `select` pula o modelo sem cota e escolhe o próximo **da mesma categoria**; categoria toda sem cota → `waiting_quota`, nunca a categoria abaixo; escada de escalada completa; custo calculado bate com a tabela de preços | Regras 2 e 5; casos de borda 1 e 2 |
| Adapters | monta args corretos (`--model`, `--effort`/`--reasoning-effort`, `-p`, `--output-format json`); lê tokens das fixtures reais; código de saída ≠ 0 → `ok=false` | Dependências |
| Triagem | "renomeia uma variável" → barata/low; "refatora a fila para suportar prioridade" → forte; `override_tier` vence; JSON inválido do modelo → nova tentativa e depois erro claro | Happy path; caso 6 |
| Planejador | passos com arquivos em comum saem sequenciais; brief não leva o histórico | Regra 4; caso 7 |
| Git/CI | CI verde → merge com rebase e branch apagado; CI vermelho → falha com motivo; conflito → `conflict` | Happy path; caso 3 |
| run-step | verde na 1ª tentativa; vermelho → nova tentativa **em sessão nova** com esforço maior; 3 vermelhos → para, branch aberto, relato; conflito conta como tentativa | Regras 3 e 5; casos 2 e 3 |
| run-plan | independentes em paralelo; dependentes esperam | Caso 7 |
| Relay | bot ok → `grok_bot`, entregue; bot falhando → fluxo segue, `delivered=false`; `flush` reentrega quando o bot volta | História 3; caso 4 |
| Hook | grava a mensagem e sai rápido mesmo com o banco ocupado | História 3 |
| Dispatch | runner online → local; offline → nuvem; heartbeat expirado → redisparo no hospedado; modo nuvem recusa categoria forte por padrão | Caso 5; dependência de API key |
| Servidor MCP | cada ferramenta, chamada por um cliente MCP em memória, devolve o formato do spec; entrada inválida → erro de validação | API |
| Benchmark | triagem ≥ 90% nos 73 casos | Critério de teste |

UI: não se aplica (sem interface).

## Gate 2

**Arquitetura**
- [x] Segue um padrão definido (não há código existente; as camadas espelham a ideia do Controller → Manager → Repository/Service)
- [x] Cada camada só chama a de baixo (o servidor só chama a orquestração; a orquestração chama store, policy e adapters; adapters só chamam `exec`)
- [x] Componentes em diretórios por responsabilidade

**Tarefas**
- [x] Arquivos a mudar listados (`ARQUITETURA.md`)
- [x] Todos os arquivos novos listados com o local
- [x] Cada tarefa tem no máximo 3 arquivos e um commit
- [x] Dependências claras
- [x] Paralelo e sequencial marcados

**Testes**
- [x] Store
- [x] Lógica (política, triagem, planejador, runner)
- [x] Integração (servidor MCP, git/CI com fakes)
- [x] UI: não se aplica
- [x] Os 8 casos de borda do spec cobertos (o 8, grok bot sem API, é resolvido pelo spike da tarefa 1)

## Riscos

- **Spike do grok bot (tarefa 1):** se o grok bot não aceitar mensagens de fora, as tarefas 21 e 22 continuam válidas e só o transporte muda; o Claude fica como canal principal.
- **Formato de tokens dos CLIs:** se o `grok -p` não expuser o uso de tokens, o custo do grok fica estimado pelo tamanho do texto (marcado como estimativa no `status`).
- **Teste real de ponta a ponta** (um passo de verdade passando pelo kind e fazendo merge) só depois da tarefa 25, com um repositório de testes, antes de ligar o merge automático no repositório principal.

## Estado (2026-10-30)

Tarefas 2 a 14, 16 a 28 mergeadas (PRs #1 a #5); teste ponta a ponta real passou (PR #2, Haiku, ~US$ 0,10 antes do contexto mínimo; ~4k tokens de contexto por sessão depois).

Mudanças em relação ao plano:
- Node 26 (type stripping nativo), `tsx` ainda usado nos scripts.
- Runner self-hosted **por repositório**, desligado por padrão: o router o liga por PR (`ci/runner-up.sh`) e `ci/runner-down.sh` só desliga e derruba o kind quando nenhum CI está ativo. `ci/ship.sh` automatiza PR → CI → merge.
- O CI compara o PR com a base estável (só regressão bloqueia).
- Agentes do claude-code rodam com contexto mínimo (`--setting-sources project --strict-mcp-config --disable-slash-commands`, prompt e tools curtos).

Pendente:
- Tarefa 1 (spike do grok bot): o transporte do `relay` é um stub que sempre falha, então tudo cai no Claude.
- Tarefa 15 (benchmark da triagem contra `judge-cases.json`, meta 90%).
- Caminho de nuvem (`router-cloud.yml`) não funciona de ponta a ponta; `dispatch` e `findOrphans` não são chamados por ninguém.
- Hook `UserPromptSubmit` implementado mas não registrado em `~/.claude/settings.json`.
- Teste de dois PRs em paralelo para o cluster compartilhado.
