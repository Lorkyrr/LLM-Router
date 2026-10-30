# Spec: router-mvp

**Created**: 2026-10-30
**Status**: implemented (MVP merged, ver "Estado" no fim do plano)
**Author**: Mateus
**Epic**: none
**Fonte**: `ARQUITETURA.md` (desenho completo); este spec recorta o MVP.

## Problem

O custo e a cota das assinaturas acabam antes do fim do ciclo porque a escolha de agente, modelo e esforço é manual: modelos fortes gastam cota em tarefas simples, e não existe um fluxo que deixe o forte só desenhar e o médio só executar. Além disso, nada verifica sozinho o que o agente entregou, e o acompanhamento depende de estar no PC e no app certo.

## Goal

- Toda requisição passa por uma triagem barata e é despachada para a categoria certa (barata, média, forte) sem escolha manual.
- Modelos fortes só são usados em planejamento complexo, refatoração e sequências que não podem ser divididas; a implementação dos passos planejados roda em Sonnet medium por padrão.
- Cada tentativa registra tokens e custo estimado, e `status` mostra o gasto por categoria e quanto custaria se tudo tivesse rodado no modelo forte.
- Cada passo é verificado por CI (kind) e, se aprovado, mergeado e o branch apagado, com o PC ligado ou desligado.
- O usuário acompanha tudo por um único canal (grok bot), com o Claude como segunda linha.

## Política de modelos

| Categoria | Quando | Padrão | Exemplos de modelo |
|---|---|---|---|
| barata | triagem, roteamento, perguntas simples, código de propósito único que não afeta a estrutura | low | Haiku 5.5, Grok fast, Gemini Flash |
| média | implementar passos planejados: partes que se conectam a outras, código concorrente | Sonnet medium | Sonnet 5.5, gpt-codex |
| forte | planejamento complexo, refatoração, sequências que não podem ser divididas em branches; desenha estrutura, escopo e tarefas | high | Opus 5.5, Grok reasoning |

Regras:
1. **Cada modelo pertence a uma só categoria.** (Corrige o `gemini-pro` duplicado no `ARQUITETURA.md`.)
2. **Fallback só na mesma categoria.** Sem cota ou indisponível → próximo modelo da mesma categoria, na ordem de preferência. Nunca desce de categoria.
3. **Modelo é escolhido no despacho, nunca no meio de uma sessão.** Cada passo e cada tentativa abre sessão nova. (effortless mediu: trocar de modelo no meio de uma conversa custa 5–10x por causa do cache.)
4. **O forte entrega ao médio um brief curto do passo**, não o histórico. (effortless: 76% do custo é reler a conversa.)
5. **Escalada sobe esforço, depois categoria, até 3 tentativas:**
   - barata → média medium → média high
   - média medium → high → xhigh
   - forte high → xhigh → para e relata
6. Dentro de uma sessão do claude-code, o effortless continua ajustando o esforço; o router só define o ponto de partida.

### Base teórica (plugin effortless, `bench/RESULTS.md`)

- Sonnet medium acertou 12/12 nas tarefas de código; high custa +10% e xhigh +35% sem ganho medido → padrão medium.
- Haiku low acertou 75–83% das tarefas fáceis contra Opus → barata só para o realmente trivial; CI cobre o resto.
- Juiz de esforço Haiku: 93% de acerto (95% no conjunto separado) → triagem com Haiku low.
- Fable 5.1 e mais antigos: mudar esforço entre requisições reescreve o cache → nunca mudar esforço numa sessão aberta desses modelos.
- `bench/judge-cases.json` (73 casos rotulados) vira semente dos testes de triagem.

## User Stories

1. **Como** dono das assinaturas, **quero** que perguntas simples e código trivial vão para modelos baratos e que o forte só desenhe e divida o trabalho, **para** a cota durar o ciclo todo.
2. **Como** usuário falando com o grok bot, **quero** descrever a tarefa e ele despachar para agente, modelo e esforço certos, **para** não escolher na mão.
3. **Como** usuário longe do PC, **quero** que mensagens enviadas a qualquer agente e os relatos do router cheguem ao grok bot, **para** não depender de um app específico.
4. **Como** usuário, **quero** que cada passo seja testado num cluster kind e mergeado só se passar, **para** não revisar tudo na mão.
5. **Como** dono das assinaturas, **quero** ver tokens e custo estimado por tentativa e a economia contra rodar tudo no forte, **para** saber se o router compensa.

## Requirements

### Must-have
- Servidor MCP em TypeScript com as ferramentas `route`, `plan`, `run_plan`, `status`, `check_models`, `relay`.
- Triagem com modelo barato em low que só classifica fase e categoria.
- Catálogo e política em `config/router.yaml` (categorias, preferência, fases, escalada).
- Teste de disponibilidade na inicialização e periódico.
- Planejador no modelo forte: tarefa única ou passos com categoria, brief, dependências e arquivos tocados.
- Adaptadores **claude-code** e **grok build** (cobrem as três categorias).
- Fila e estado em SQLite, incluindo tokens e custo estimado por tentativa.
- Escalada e fallback conforme a política acima.
- Verificação: branch por passo → PR → CI com kind → se passar, rebase na main, merge, branch apagado.
  - PC ligado: runner self-hosted do GitHub no PC (sobe kind, testa, derruba).
  - PC desligado: runners hospedados do GitHub (gasta minutos de Actions só nesse caso).
- Disparo em modo nuvem: a ponte dispara `gh workflow run` quando o router local não responde.
- Hooks que repassam ao grok bot as mensagens enviadas aos agentes (começando pelo `UserPromptSubmit` do claude-code).
- Canal: grok bot principal; Claude como segunda linha.

### Nice-to-have
- Rodar `bench/judge-cases.json` contra a triagem como benchmark (`/router bench`).
- Relatório semanal de economia por categoria.

### Out of scope
- Adaptadores zed, antigravity, codex e grok bot como executor (o grok bot é só ponte, para evitar laço de despacho).
- Importadores de sessão e sincronizador de sessões.
- Juiz por LLM na verificação.
- Interface gráfica.

## Data Model (SQLite, local)

Estado local de um usuário; não segue as regras de Postgres/Exposed do CLAUDE.md global (este projeto é TypeScript). Todas as tabelas têm `id TEXT` (UUID), `created_at` e `updated_at` (ISO 8601 UTC). **Sem soft delete:** nada é apagado, o histórico é a fonte do relatório de custo; o fim de vida é o campo `status`.

| Tabela | Colunas principais |
|---|---|
| `tasks` | `request`, `phase`, `tier`, `status` (queued, planning, running, done, failed, waiting_quota), `source_channel` |
| `steps` | `task_id`, `seq`, `brief`, `tier`, `depends_on` (JSON), `files` (JSON), `branch`, `pr_number`, `status` |
| `attempts` | `step_id`, `n`, `adapter`, `model`, `effort`, `runner` (self_hosted, hosted), `ci_result`, `failure_reason`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `est_cost_usd`, `started_at`, `finished_at` |
| `models` | `name`, `adapter`, `tier`, `preference`, `available`, `quota_state`, `checked_at` |
| `messages` | `direction`, `channel` (grok_bot, claude), `body`, `delivered`, `delivered_at`, `task_id` |

`est_cost_usd` usa tabela de preço por modelo em `config/router.yaml`; tentativa em assinatura registra custo equivalente de API para comparação.

## API (ferramentas MCP)

Argumentos e respostas em JSON `snake_case`.

`route`
```json
// entrada
{ "request": "adiciona um campo timeout no router.yaml", "override_tier": null }
// saída
{ "task_id": "…", "phase": "simple_edit", "tier": "cheap", "model": "haiku-5-5", "adapter": "claude-code", "effort": "low", "next": "run" }
```

`plan`
```json
{ "task_id": "…" }
// saída
{ "steps": [ { "seq": 1, "tier": "mid", "brief": "…", "depends_on": [], "files": ["src/queue/db.ts"] } ] }
```

`run_plan` → `{ "task_id": "…" }` → `{ "started": [1, 2], "waiting": [3] }`

`status` → `{ "task_id": "…" | null }` → tarefas, passos, tentativas, PRs, e `{ "cost": { "by_tier": {…}, "all_strong_baseline_usd": 1.20, "actual_usd": 0.41 } }`

`check_models` → `{}` → lista de modelos com `available`, `quota_state`, `checked_at`

`relay` → `{ "body": "…", "task_id": "…" }` → `{ "channel": "grok_bot" | "claude", "delivered": true }`

## UI Changes

Nenhuma. A interface é a conversa com o grok bot ou com o Claude.

## Edge Cases

1. **Nenhum modelo da categoria disponível:** tarefa fica `waiting_quota` na fila, sem descer de categoria; aviso pelo canal.
2. **3 tentativas falharam:** para, deixa o branch aberto, relata o motivo para decisão do usuário.
3. **Conflito de merge entre passos paralelos:** rebase na main; se persistir, volta ao médio com o conflito no brief (conta como tentativa).
4. **Grok bot offline:** o Claude assume a ponte e o fluxo continua; mensagens ficam `delivered = false` e o bot recebe um resumo quando voltar.
5. **PC desliga com passo no runner local:** passo sem heartbeat após o tempo limite é redisparado no runner hospedado.
6. **Triagem classifica errado:** falha no CI escala; o usuário pode forçar a categoria (`override_tier`).
7. **Dois passos tocam os mesmos arquivos:** o planejador os marca como sequenciais.
8. **Grok bot não aceita mensagens externas:** ver Dependências; o Claude vira canal principal até haver solução.

## Testing Criteria

### Happy path
- `route` de "renomeia uma variável" → `tier = cheap`, `effort = low`.
- `route` de "refatora a fila para suportar prioridade" → `tier = strong`.
- `plan` de uma feature de 3 partes gera passos `mid` com brief, dependências e arquivos; passos com arquivos em comum saem sequenciais.
- `run_plan` cria branch e PR por passo; CI verde → rebase, merge, branch apagado; `attempts` com tokens e custo.
- `status` soma custo por categoria e a linha de base "tudo no forte".
- `relay` com bot online → `channel = grok_bot`, `delivered = true`.

### Edge cases
- Modelo marcado sem cota → fallback para o próximo da mesma categoria; categoria inteira sem cota → `waiting_quota`, nunca categoria inferior.
- CI vermelho → nova tentativa com esforço maior, sessão nova; 3 falhas → para e relata.
- Conflito de merge simulado → passo volta ao médio.
- Bot offline (endpoint falhando) → fluxo segue, mensagem `delivered = false`, reentregue quando o bot volta.
- Heartbeat do runner local expira → passo redisparado no hospedado.
- Triagem contra `bench/judge-cases.json`: acerto de categoria ≥ 90%.

## Dependencies

- **A validar primeiro:** o grok bot consegue receber mensagens enviadas pelo router e chamar ferramentas MCP (ou uma API HTTP)? Se for o Grok do app/x.com sem API de entrada, o canal principal passa a ser o Claude até existir um bot próprio.
- `claude` (`~/.local/bin/claude`) e `grok` (`~/.local/bin/grok`, flags `-m`, `--reasoning-effort`, `-p`, `--output-format json`) com saída que exponha uso de tokens.
- `gh` autenticado; runner self-hosted do GitHub no PC; `kind` e Docker.
- Repositório no GitHub com workflows `router-verify.yml` (self-hosted) e `router-cloud.yml` (hospedado, `workflow_dispatch`).
- No modo nuvem, os agentes rodam com **API key** nos Secrets (cobrança por token, não pela assinatura): limitar o modo nuvem às categorias barata e média por padrão.
- Plugin effortless instalado (base teórica e ajuste de esforço dentro das sessões do claude-code).
