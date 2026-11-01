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

1. `route({request})` retorna categoria/modelo/esforço para pedidos únicos e `subtasks` com modelo/motivo/dependências para cada item; modelos com metadados também retornam diretriz e origem do preço.
2. Se `next` for `plan`, chame `plan({task_id})`.
3. `run_plan({task_id})` inicia passos. O fluxo publica PRs e tenta merge após CI; execute apenas em repositórios autorizados.
4. `status({task_id})` acompanha resultados e custo registrado/estimado.

`check_models` testa disponibilidade; `relay` usa fallback Claude enquanto o bot não estiver configurado. `phases.<fase>.prefer` divide responsabilidades: Opus planeja, Sol implementa e Astra integra/revisa, com fallback entre agentes da mesma categoria. Para triagem Codex, use `triage.model: gpt-6-luna`. Detalhes e ressalvas estão na política de modelos.

Mensagens com várias tarefas usam heurística primeiro e fallback apenas cheap/low.
`route` já grava os passos reconhecidos e retorna `next: run`; cada item recebe sua
fase e esforço, sem promover o pedido inteiro para strong. `depois` aguarda itens
anteriores; `e também`/`enquanto isso` permitem independência. `verify.max_parallel`
limita passos simultâneos por plano (padrão 2). Exemplos, saída e limites estão na
[política de decomposição](docs/model-policy.md#mensagens-com-várias-tarefas).

## Modo local (sem GitHub nem CI)

`ROUTER_LOCAL_TEST="npm run typecheck && npm test"` (ou `verify.mode: local` + `verify.local.cmds` no catálogo; comandos em ordem, o primeiro que falhar encerra) faz `run_plan` verificar e mesclar com Git local. Cada passo roda num worktree em `.worktrees/` e o comando de teste no worktree decide o resultado. Teste vermelho tenta reparo pontual antes de reentrar na escada. Teste verde faz rebase no base e fast-forward no checkout do projeto, serializado entre passos paralelos. A verificação dispensa fetch, PR e `gh`; os backups publicam os branches dos passos, o base mesclado e o histórico (`verify.push`, abaixo).

### Reparo antes da escalada

Falhas de gate em `local`, `staged` e nos checks de `pr` tentam até `repair.max` reparos por tentativa de tarefa (padrão 1). Cada reparo recebe só as últimas 60 linhas do diagnóstico, com arquivos/testes falhos quando presentes na saída, e o diff completo commitado do branch contra o merge-base do base. Roda no mesmo worktree, com instrução de corrigir apenas aquele erro, sem receber o brief original. Após cada reparo, o mesmo gate decide o resultado.

```yaml
repair:
  enabled: true
  max: 1
  simple:
    max_failed_tests: 2
    max_diff_lines: 100
    patterns: ['error TS\d+', 'SyntaxError', 'Cannot find module', 'Module not found', 'Cannot find name', '\blint\b', 'Parsing error']
```

A heurística determinística usa o diagnóstico disponível, sem juiz LLM: conta linhas adicionadas/removidas (sem cabeçalhos) e falhas reportadas em TAP/node:test, Jest/Vitest ou `N failed/failing`. Dentro dos dois limiares, um padrão regex (case-insensitive) reconhecido ou poucos testes falhos classifica como simples: cheap/low no primeiro reparo, cheap/medium nas repetições. Diagnóstico desconhecido, muitos testes ou diff grande mantêm tier e esforço da tentativa de tarefa original. Padrões são validados ao carregar a configuração; não há classificação semântica nem garantia de economia real.

Reparos consomem `escalation.max_attempts`, sem orçamento extra, para preservar o teto de falhas inclusive ao retomar um passo. Cota esgotada continua sem consumir esse teto nem `repair.max` e tenta outro modelo da categoria do reparo. Categoria indisponível pula o reparo. Depois do limite, a escada retoma os outros modelos do tier original e os degraus configurados; o reparo barato não altera essa categoria. `enabled: false` ou `max: 0` restauram o fluxo anterior. `agent made no changes`, erro do agente, conflito, checks pendentes/ausentes e falha de merge seguem a escada diretamente. Erro ao obter diff encerra o passo explicitamente.

O SQLite registra `attempts.kind` (`task|repair`) e `attempts.reason` (classificação/motivo), além de modelo, tier, esforço, uso e resultado. A migração é aditiva/idempotente e marca tentativas antigas como `task`. O backup público inclui `kind`; `reason` e diagnósticos permanecem privados, como `failure_reason`.

### Modo staged: gate local e depois PR + CI + auto-merge

`ROUTER_VERIFY_MODE=staged` (ou `verify.mode: staged`) usa os mesmos `verify.local.cmds` como **gate local**: depois de `git fetch` e rebase em `origin/<base>`, os comandos rodam no worktree. Vermelho ou conflito volta ao agente (`ci_result` `local_failed`/`local_conflict`) sem push nem PR. Verde faz push e **abre o PR, e para aí**: o passo fica `pr_open` e a tarefa `awaiting_release`. Nenhum CI do GitHub roda e nada é mergeado até você sinalizar.

O sinal é a ferramenta MCP `release` (ou `gh workflow run router-release.yml`). O workflow compara todos os PRs `router/*` abertos (arquivos em comum), roda o CI de cada um sobre a base atualizada (`ci/pr-ci.sh`), faz merge (rebase) dos verdes, apaga o branch e comenta nos vermelhos, que ficam abertos. PR empilhado sobre um que não passou é pulado. Depois, `release {sync_only: true}` (ou o fim do workflow disparado pelo MCP) atualiza o estado local: mergeado vira `done` e perde worktree/branch locais. Passos dependentes de um PR ainda aberto partem do branch dele. O `router-verify` ignora PRs `router/*`. `verify.auto_merge` não vale no `staged`: quem mergeia é o `release`. Exige remoto, `gh` autenticado e runner de CI; veja `docs/staged-verify-design.md`.

- O checkout de `ROUTER_REPO_DIR` precisa estar no branch base: `ROUTER_BASE` se definido, senão o branch em checkout quando o servidor sobe (os worktrees dos passos partem dele); caso contrário o passo falha em vez de mesclar no branch errado. Arquivos não commitados que colidam com o merge também o fazem falhar.
- `verify.push: always|never` (padrão `always`): todo branch `router/step-*` é publicado em `origin` (`git push -u`) ao ser criado e de novo após cada tentativa com commits, inclusive as que falham, em qualquer `verify.mode`. No modo `local`, após `auto_merge`, o base local também sobe com `git push origin refs/heads/<base>:refs/heads/<base>`, sem force. Falha de push só avisa no stderr e não muda o resultado do passo; o próximo merge com push tenta publicar o base novamente, incluindo merges pendentes. O branch remoto do passo só é apagado com `delete_branch: true` e publicação bem-sucedida do base; sem merge ou com push do base falhando, fica preservado. `never` desliga os backups de passos, base e histórico (os modos `pr` e `staged` ainda dão push para abrir o PR). Uma tentativa que falha no modo `pr` só sobe se o agente tiver commitado.
- `verify.auto_merge: false` deixa o branch `router/step-*` e o worktree para revisão; o passo conta como `done`. Nos modos `pr` e `staged` o PR fica aberto após o CI verde, sem merge.
- Os testes não rodam de novo após o rebase. Teste com git real e agente falso: `src/runner/run-step.local.test.ts`. Nenhum modelo real foi usado nesse fluxo.

### Backup do histórico

Ao fim de cada `run_plan`, depois de gravar o estado final (inclusive falha, espera de cota e `awaiting_release`), `verify.push: always` publica um snapshot de todo o `router.db` selecionado em `origin/router/state`, no arquivo `history.jsonl`. Não há checkout, alteração do índice, commit no branch de trabalho nem force-push. O branch dedicado começa com um commit raiz e os próximos commits seguem seu histórico remoto. Snapshot idêntico não cria commit. Falhas de rede, credenciais ou concorrência só avisam; o próximo `run_plan` tenta novamente com o snapshot completo. Sem rede, não há garantia de backup externo até uma publicação bem-sucedida.

O JSONL v1 tem uma linha de schema e linhas `task`, `step` e `attempt`, ordenadas de forma determinística. Preserva IDs, dependências, estados, datas UTC, PR, agente/modelo/esforço, resultado da verificação, tokens e `est_cost_usd` (incluindo `null` quando ausente). Custos continuam registrados/estimados, com `billing_verified: false`. Uma lista positiva de colunas exclui request, brief, caminhos de arquivos, branch, canal, mensagens, motivo de falha, configuração e credenciais; prompts e logs não são publicados. É um backup do histórico operacional e de custos, sem o texto necessário para reexecutar tarefas ou restaurar integralmente o banco.

Use `ROUTER_DB` separado por projeto: o banco padrão é global e todos os seus registros operacionais serão exportados. O último snapshot corresponde ao banco da máquina que publicou; snapshots anteriores ficam no histórico Git. Máquinas com bancos distintos não têm sincronização/união de registros automática.

Para consultar sem mudar o checkout:

```bash
git fetch origin router/state
git show FETCH_HEAD:history.jsonl
```

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
- [Fluxo completo do roteamento e execução](docs/fluxo-completo.md)
- [Preços e diretrizes](docs/model-policy.md)
- [Cooperação entre agentes e próxima integração Grok-Bot](docs/agent-cooperation.md)
- [Instruções para contribuidores e agentes](AGENTS.md)
- [Validação manual](docs/e2e-smoke.md)

O workflow cloud permanece esqueleto: banco remoto, instalação dos CLIs e acionamento da verificação precisam de integração. O adaptador Codex não resolve essas pendências. Os testes reais de leitura tentados não completaram; não há validação ponta a ponta com os modelos.

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE). Projeto open-source: derivados distribuídos devem permanecer sob a mesma licença.
