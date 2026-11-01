# LLM-Router

Servidor MCP local que classifica tarefas, escolhe modelo e esforço, divide trabalho em passos e executa agentes em worktrees com verificação por CI.

## Agentes

- Claude Code: `claude -p --output-format json`.
- Grok Build: `grok -p --output-format json`.
- Codex: `codex exec --json --ephemeral`, com sandbox e modelo/esforço explícitos.

Os executáveis precisam estar no `PATH` e autenticados. Codex CLI 0.166.0 foi inspecionado nesta integração; suporte de cada modelo depende da conta e é verificado por ping. Os trabalhadores abrem sessões novas, sem alterar o modelo da conversa que chamou o MCP.

## Desenvolvimento

Requer Node.js >=24, Git e GitHub CLI (`gh`); o launcher compatível com sandboxes usa Python 3. Para executar passos são necessários autenticação GitHub, permissão de PR e runner de verificação do repositório alvo.

```bash
npm ci
npm test
npm run typecheck
ROUTER_REPO_DIR=/caminho/do/projeto npm start
```

Conecte `npm start` pelo cliente MCP via stdio. A inicialização faz pings pagos dos modelos habilitados. Configure `ROUTER_CONFIG` e `ROUTER_DB` para substituir catálogo e banco padrão. O banco global não identifica repositórios por tarefa: use um `ROUTER_DB` por projeto ao trabalhar com vários repositórios.

## Uso por MCP

1. `route({request})` retorna categoria/modelo/esforço; modelos com metadados também retornam diretriz e origem do preço.
2. Se `next` for `plan`, chame `plan({task_id})`.
3. `run_plan({task_id})` inicia passos. O fluxo publica PRs e tenta merge após CI; execute apenas em repositórios autorizados.
4. `status({task_id})` acompanha resultados e custo registrado/estimado.

`check_models` testa disponibilidade; `relay` usa fallback Claude enquanto o bot não estiver configurado. `phases.<fase>.prefer` divide responsabilidades: Opus planeja, Sol implementa e Astra integra/revisa, com fallback entre agentes da mesma categoria. Para triagem Codex, use `triage.model: gpt-6-luna`. Detalhes e ressalvas estão na política de modelos.

## Modo local (sem GitHub nem CI)

`ROUTER_LOCAL_TEST="npm run typecheck && npm test"` (ou `verify.mode: local` + `verify.local.cmds` no catálogo; comandos em ordem, o primeiro que falhar encerra) faz `run_plan` trabalhar só com Git local. Cada passo roda num worktree em `.worktrees/` e o comando de teste no worktree decide o resultado. Teste vermelho reentra na escada de esforço com a saída no prompt. Teste verde faz rebase no base e fast-forward no checkout do projeto, serializado entre passos paralelos. Sem `git fetch`, push, PR nem `gh`.

### Modo staged: gate local e depois PR + CI + auto-merge

`ROUTER_VERIFY_MODE=staged` (ou `verify.mode: staged`) usa os mesmos `verify.local.cmds` como **gate local**: depois de `git fetch` e rebase em `origin/<base>`, os comandos rodam no worktree. Vermelho ou conflito volta ao agente (`ci_result` `local_failed`/`local_conflict`) sem push nem PR. Verde faz push e **abre o PR, e para aí**: o passo fica `pr_open` e a tarefa `awaiting_release`. Nenhum CI do GitHub roda e nada é mergeado até você sinalizar.

O sinal é a ferramenta MCP `release` (ou `gh workflow run router-release.yml`). O workflow compara todos os PRs `router/*` abertos (arquivos em comum), roda o CI de cada um sobre a base atualizada (`ci/pr-ci.sh`), faz merge (rebase) dos verdes, apaga o branch e comenta nos vermelhos, que ficam abertos. PR empilhado sobre um que não passou é pulado. Depois, `release {sync_only: true}` (ou o fim do workflow disparado pelo MCP) atualiza o estado local: mergeado vira `done` e perde worktree/branch locais. Passos dependentes de um PR ainda aberto partem do branch dele. O `router-verify` ignora PRs `router/*`. `verify.auto_merge` não vale no `staged`: quem mergeia é o `release`. Exige remoto, `gh` autenticado e runner de CI; veja `docs/staged-verify-design.md`.

- O checkout de `ROUTER_REPO_DIR` precisa estar no branch base: `ROUTER_BASE` se definido, senão o branch em checkout quando o servidor sobe (os worktrees dos passos partem dele); caso contrário o passo falha em vez de mesclar no branch errado. Arquivos não commitados que colidam com o merge também o fazem falhar.
- `verify.auto_merge: false` deixa o branch `router/step-*` e o worktree para revisão; o passo conta como `done`. Nos modos `pr` e `staged` o PR fica aberto após o CI verde, sem merge.
- Os testes não rodam de novo após o rebase. Teste com git real e agente falso: `src/runner/run-step.local.test.ts`. Nenhum modelo real foi usado nesse fluxo.

## Cluster kind no CI (só quando necessário)

`ci/pr-ci.sh` (usado por `router-verify` e `router-release`) roda `ci/needs-cluster.sh` e só executa `ci/kind-up.sh` se o resultado for `kind`; o override `CI_CLUSTER` chega pela variável de repositório nos dois workflows; `ci/runner-down.sh` só derruba o cluster se ele existe. Os testes do próprio router rodam no host e não usam cluster.

- **Override** (precedência): variável `CI_CLUSTER=auto|kind|off` (no GitHub, a variável de repositório `CI_CLUSTER`) > `verify.cluster` em `config/router.yaml` > `auto` (padrão). Valor inválido faz o passo falhar.
- **`auto` sobe o cluster** se achar: `Chart.yaml` ou `kustomization.yaml|yml`; arquivo `PROJECT` de kubebuilder/operator-sdk; YAML com `apiVersion:` e `kind:` no topo (inclui CRDs); pastas `k8s/`, `deploy/`, `manifests/` ou `charts/` com YAML dentro; arquivos de teste (`*.test.*`, `*.spec.*`, `*_test.*`, `test_*`, `e2e/`, `tests/`) que citam `kubectl`, `KUBECONFIG`, `@kubernetes/client-node` ou `envtest` (menos os testes do próprio detector, `needs-cluster*`). Ignora `node_modules`, `.git`, `.worktrees` e `vendor`.
- Limites: heurística por texto. Um YAML não-k8s com `apiVersion`+`kind` no topo causa falso positivo (use `off`); manifests gerados em tempo de build não são vistos (use `kind`). A saída explica o motivo: `ci/needs-cluster.sh [dir]`.

## Conexão ao Claude Code

O servidor está registrado como `llm-router` em `~/.claude.json` com o comando Python e caminhos absolutos. Abra uma nova sessão do Claude Code e confira `/mcp`, ou execute `claude mcp get llm-router`. A conexão stdio é iniciada pelo cliente; não exige um daemon independente.

`bin/router-mcp.py` encaminha pipes convencionais para Node, evitando perda de stdio em sandboxes que bloqueiam identificação de sockets. O import absoluto do tsx funciona mesmo fora do diretório de instalação. `ROUTER_CHECK_MODELS=manual` desativa pings automáticos; `check_models` continua disponível sob demanda. O registro local usa esse modo para que abrir Claude não faça chamadas pagas inesperadas.

O handshake real foi validado com o SDK MCP. Neste sandbox, `claude mcp get` fecha a conexão antes de enviar o handshake; criar sockets retorna `EPERM` e consultas externas apresentam falha de DNS. Portanto o registro está preparado, mas conexão do Claude e modelos reais ainda precisam ser confirmados em terminal sem essas restrições. Veja o relatório de validação em `docs/e2e-smoke.md`.

## Documentação

- [Arquitetura e limites atuais](ARQUITETURA.md)
- [Preços e diretrizes](docs/model-policy.md)
- [Cooperação entre agentes e próxima integração Grok-Bot](docs/agent-cooperation.md)
- [Instruções para contribuidores e agentes](AGENTS.md)
- [Validação manual](docs/e2e-smoke.md)

O workflow cloud permanece esqueleto: banco remoto, instalação dos CLIs e acionamento da verificação precisam de integração. O adaptador Codex não resolve essas pendências. Os testes reais de leitura tentados não completaram; não há validação ponta a ponta com os modelos.
