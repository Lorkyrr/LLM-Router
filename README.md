# LLM-Router

Router MCP por **stdio**, em TypeScript, que faz triagem (`triage`), planejamento (`plan`) e roteia tarefas de programação para Claude Code e Codex CLI, escolhendo modelo, categoria (`tier`: `cheap`, `mid`, `strong`) e esforço por fase. Executa passos em worktrees Git e registra estado, tentativas e uso em SQLite.

O catálogo atual usa apenas Claude Code e Codex, **com Grok desativado**: não há modelos Grok ativos no [YAML versionado](config/router.yaml). O adaptador `grok-build` continua registrado, e o transporte do Grok Bot ainda não foi configurado.

Os trabalhadores abrem sessões novas, com modelo e esforço explícitos, sem alterar o modelo da conversa que chamou o MCP. As preferências atuais são Opus para executar passos de planejamento, Sol para implementação e Astra para integração/revisão, com alternativas da mesma categoria. A decomposição feita por `plan` usa heurística ou cheap/low. São hipóteses de configuração, ainda sem benchmark comparativo local. Terra permanece desativado.

## Instalação

Requer Node.js >=24, npm, Python 3, Git e os CLIs `claude` e `codex` no `PATH`, autenticados. Os modos com GitHub também exigem `gh` autenticado, remoto `origin`, permissões para publicar branches/PRs e infraestrutura de CI no repositório alvo.

Na pasta da instalação do LLM-Router:

```bash
npm ci
npm test
npm run typecheck
```

O cliente MCP inicia o servidor sob demanda; não é necessário um daemon. Use [bin/router-mcp.py](bin/router-mcp.py): ele encaminha pipes reais para Node e resolve o `tsx` a partir da instalação, inclusive quando as dependências estão em um `node_modules` ancestral do worktree. O launcher funciona fora da pasta da instalação e preserva o diretório de trabalho do projeto. `ROUTER_NODE` ou `--node` seleciona o executável Node quando necessário.

`npm start` também inicia o servidor por stdio e, sem `ROUTER_CHECK_MODELS=manual`, faz verificações com modelos reais. Para validar a instalação sem consumir cota, use os testes acima.

### Registro no Claude Code

Substitua os caminhos absolutos abaixo pelos da instalação e do projeto alvo:

```bash
claude mcp add --transport stdio --scope local \
  --env ROUTER_REPO_DIR=/caminho/absoluto/do/projeto \
  --env ROUTER_DB=/caminho/absoluto/do/projeto/.router/router.db \
  --env ROUTER_CHECK_MODELS=manual \
  llm-router -- python3 /caminho/absoluto/LLM-Router/bin/router-mcp.py

claude mcp get llm-router
```

Abra uma nova sessão no projeto e confira `/mcp`.

### Registro no Codex

```bash
codex mcp add \
  --env ROUTER_REPO_DIR=/caminho/absoluto/do/projeto \
  --env ROUTER_DB=/caminho/absoluto/do/projeto/.router/router.db \
  --env ROUTER_CHECK_MODELS=manual \
  llm-router -- python3 /caminho/absoluto/LLM-Router/bin/router-mcp.py

codex mcp get llm-router
```

Use o mesmo `ROUTER_DB` nos clientes que coordenam o mesmo projeto. Para outro projeto, use outro banco e ajuste `ROUTER_REPO_DIR`. O banco padrão é `~/.local/share/llm-router/router.db`, e as tarefas não têm identificação de repositório: compartilhar esse banco entre projetos pode misturar estados.

`ROUTER_CHECK_MODELS=manual` evita pings pagos ao abrir o cliente. Sem essa opção, o servidor verifica modelos na inicialização e tenta novamente os indisponíveis a cada 30 minutos. `check_models` continua disponível sob demanda e consome tokens. Autenticação e presença no catálogo não comprovam acesso a um modelo.

## Ferramentas MCP

| Ferramenta | Entrada | Comportamento |
| --- | --- | --- |
| `route` | `request`, `override_tier?` | Classifica a fase, cria a tarefa e retorna `task_id`, tier, modelo, adaptador, esforço e `next` (`plan`, `run` ou `wait`). Para pedidos múltiplos, retorna `subtasks` com fase, modelo, esforço, motivo e dependências por item. Inclui diretriz e fonte de preço quando disponíveis. |
| `plan` | `task_id` | Divide a tarefa por heurística ou modelo cheap/low em passos com briefs, arquivos, categorias e dependências. |
| `run_plan` | `task_id` | Inicia os passos em segundo plano e retorna os números dos passos iniciados e aguardando dependências. |
| `status` | `task_id?` | Retorna custos agregados; com ID, inclui tarefa, passos e tentativas. |
| `check_models` | `{}` | Faz ping dos modelos habilitados e grava disponibilidade e estado de cota. |
| `relay` | `body`, `task_id?` | Tenta enviar uma mensagem ao Grok Bot; com o transporte atual indisponível, registra fallback para o canal Claude e retorna `delivered: false`. |
| `release` | `sync_only?` | Sinaliza a liberação dos PRs staged pelo workflow; com `sync_only: true`, apenas sincroniza o estado local com o GitHub. |

Fluxo habitual:

1. Chame `route({request: "..."})`.
2. Se `next` for `plan`, chame `plan({task_id: "..."})`. Pedidos únicos `cheap`/`mid` já recebem um passo; pedidos múltiplos reconhecidos recebem vários passos e `next: run`; `wait` indica ausência de modelo disponível.
3. Chame `run_plan({task_id: "..."})` e acompanhe `status({task_id: "..."})`.
4. No modo `staged`, os PRs aguardam `release({})`. Depois, `release({sync_only: true})` permite atualizar o estado local se necessário.

Os custos misturam dados devolvidos pelos CLIs e estimativas do catálogo. Não são fatura nem saldo da assinatura; `status` informa `billing_verified: false`.

### Decomposição multi-tarefa

Mensagens com várias tarefas usam heurística primeiro e fallback apenas cheap/low.
`route` já grava os passos reconhecidos e retorna `next: run`; cada item recebe sua
fase e esforço, sem promover o pedido inteiro para strong. `depois` aguarda itens
anteriores; `e também`/`enquanto isso` permitem independência. `verify.max_parallel`
limita passos simultâneos por plano (padrão 2). Exemplos, saída e limites estão na
[política de decomposição](docs/model-policy.md#mensagens-com-várias-tarefas).

## Configuração

[config/router.yaml](config/router.yaml) define modelos, preços e fontes, triagem, categorias, preferências por fase (`phases.<fase>.prefer`), escadas de esforço e verificação. Modelos com `enabled: false` não são selecionados nem pingados. Preferências dependem da disponibilidade local; falta de cota permite fallback na mesma categoria.

| Variável | Função |
| --- | --- |
| `ROUTER_CONFIG` | Caminho de um catálogo alternativo; o padrão vem da instalação. |
| `ROUTER_DB` | Caminho do SQLite; use um por projeto. |
| `ROUTER_REPO_DIR` | Repositório alvo; padrão: diretório de trabalho do processo. |
| `ROUTER_BASE` | Branch base; no modo local, padrão: branch em checkout ao iniciar; nos demais modos, `main`. |
| `ROUTER_CHECK_MODELS` | `manual` desliga as verificações automáticas de modelos. |
| `ROUTER_LOCAL_TEST` | Atalho para comandos locais, por exemplo `npm run typecheck && npm test`. |
| `ROUTER_VERIFY_MODE` | Com o atalho `ROUTER_LOCAL_TEST`, escolhe `local` (padrão do atalho) ou `staged`. Para `pr`, use o YAML. |
| `ROUTER_RUNNER` | Instância do runner; por padrão derivada como `owner-repo` do remoto `origin`. |
| `ROUTER_NODE` | Executável Node usado pelo launcher Python; padrão: `node` encontrado no `PATH`. |

`ROUTER_LOCAL_TEST` é separado por `&&` e espaços, sem interpretação completa de shell. Para definir argumentos diretamente, use listas em `verify.local.cmds`:

```yaml
verify:
  mode: staged  # local | pr | staged
  local:
    cmds:
      - [npm, run, typecheck]
      - [npm, test]
    timeout_s: 1800
  auto_merge: true
  delete_branch: true
  max_parallel: 2
  push: always
```

### Verificação e push de branches

| Modo | Verificação | Resultado |
| --- | --- | --- |
| `local` | Comandos locais em sequência no worktree; falha retorna ao agente com a saída. | Com `auto_merge: true`, rebase na base local e fast-forward no checkout do projeto. A verificação dispensa fetch, PR e GitHub; backups podem publicar código e estado. |
| `pr` | Publica branch e PR e acompanha os checks do GitHub. | Pode fazer merge após checks verdes e remover o branch conforme a configuração. |
| `staged` | Fetch, rebase em `origin/<base>` e comandos locais antes de publicar. | Gate verde faz push e abre PR; passo fica `pr_open` e tarefa `awaiting_release`. CI e merge aguardam `release`. |

O catálogo atual omite `verify.mode`, cujo padrão é `pr`. Os modos `local` e `staged` exigem `verify.local.cmds`. No `local`, o checkout alvo precisa estar no branch base para o merge automático; com `auto_merge: false`, o resultado permanece no branch/worktree para revisão. No `pr`, essa opção mantém o PR aberto após checks verdes. No `staged`, quem faz o merge é o workflow de release; `verify.auto_merge` não controla essa etapa.

No modo `local`, os testes rodam antes do rebase e não são repetidos depois dele.

Cada passo usa um branch `router/step-*` e worktree em `.worktrees/`. **`run_plan` pode publicar alterações**: nos modos `pr` e `staged`, o push usa `git push -u --force-with-lease origin <branch>` para publicar ou atualizar o branch do passo após rebases. No `staged`, falha no gate local impede a criação do PR; o backup do branch ainda ocorre quando `verify.push: always`. Passos dependentes podem partir do branch de um PR ainda aberto.

`verify.push: always|never` (padrão `always`): todo branch `router/step-*` é publicado em `origin` (`git push -u`) ao ser criado e de novo após cada tentativa com commits, inclusive as que falham, em qualquer `verify.mode`. No modo `local`, após `auto_merge`, o base local também sobe com `git push origin refs/heads/<base>:refs/heads/<base>`, sem force. Falha de push só avisa no stderr e não muda o resultado do passo; o próximo merge com push tenta publicar o base novamente, incluindo merges pendentes. O branch remoto do passo só é apagado com `delete_branch: true` e publicação bem-sucedida do base; sem merge ou com push do base falhando, fica preservado. `never` desliga os backups de passos, base e histórico (os modos `pr` e `staged` ainda dão push para abrir o PR). Uma tentativa que falha no modo `pr` só sobe se o agente tiver commitado.

O release compara os PRs abertos com prefixo `router/`, verifica cada um sobre a base atualizada, faz merge por rebase dos verdes e remove seus branches remotos. PRs com falha ficam abertos; dependentes de um PR que não passou são pulados. A sincronização marca passos mergeados como `done` e remove seus worktrees e branches locais.

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

### Backup do histórico

Ao fim de cada `run_plan`, depois de gravar o estado final (inclusive falha, espera de cota e `awaiting_release`), `verify.push: always` publica um snapshot de todo o `router.db` selecionado em `origin/router/state`, no arquivo `history.jsonl`. Não há checkout, alteração do índice, commit no branch de trabalho nem force-push. O branch dedicado começa com um commit raiz e os próximos commits seguem seu histórico remoto. Snapshot idêntico não cria commit. Falhas de rede, credenciais ou concorrência só avisam; o próximo `run_plan` tenta novamente com o snapshot completo. Sem rede, não há garantia de backup externo até uma publicação bem-sucedida.

O JSONL v1 tem uma linha de schema e linhas `task`, `step` e `attempt`, ordenadas de forma determinística. Preserva IDs, dependências, estados, datas UTC, PR, agente/modelo/esforço, resultado da verificação, tokens e `est_cost_usd` (incluindo `null` quando ausente). Custos continuam registrados/estimados, com `billing_verified: false`. Uma lista positiva de colunas exclui request, brief, caminhos de arquivos, branch, canal, mensagens, motivo de falha, configuração e credenciais; prompts e logs não são publicados. É um backup do histórico operacional e de custos, sem o texto necessário para reexecutar tarefas ou restaurar integralmente o banco.

Use `ROUTER_DB` separado por projeto: o banco padrão é global e todos os seus registros operacionais serão exportados. O último snapshot corresponde ao banco da máquina que publicou; snapshots anteriores ficam no histórico Git. Máquinas com bancos distintos não têm sincronização/união de registros automática.

Para consultar sem mudar o checkout:

```bash
git fetch origin router/state
git show FETCH_HEAD:history.jsonl
```

## CI, runner e cluster

O CI de verificação e release usa runner **self-hosted** com labels `[self-hosted, router-ci]`. [ci/runner-install.sh](ci/runner-install.sh) registra um runner por repositório (`ci/runner-install.sh owner/repo`), com `gh` autenticado e permissão administrativa. Os scripts usam serviços de usuário do systemd; quando a detecção exigir Kubernetes, o runner também precisa de `kind`, `kubectl` e ambiente capaz de criar o cluster.

O router liga o runner sob demanda durante a verificação/release. [ci/pr-ci.sh](ci/pr-ci.sh) instala dependências, detecta se há necessidade de cluster e só então sobe ou reaproveita o kind `router-ci`, compara falhas de testes com a base estável e executa o typecheck. Ao terminar, [ci/runner-down.sh](ci/runner-down.sh) desliga o runner e remove o cluster quando não há CI em execução ou na fila dos repositórios registrados. `KIND_CLUSTER` permite mudar o nome do cluster.

### Cluster kind no CI (só quando necessário)

`ci/pr-ci.sh` (usado por `router-verify` e `router-release`) roda `ci/needs-cluster.sh` e só executa `ci/kind-up.sh` se o resultado for `kind`; o override `CI_CLUSTER` chega pela variável de repositório nos dois workflows; `ci/runner-down.sh` só derruba o cluster se ele existe. Os testes do próprio router rodam no host e não usam cluster.

- **Override** (precedência): variável `CI_CLUSTER=auto|kind|off` (no GitHub, a variável de repositório `CI_CLUSTER`) > `verify.cluster` em `config/router.yaml` > `auto` (padrão). Valor inválido faz o passo falhar.
- **`auto` sobe o cluster** se achar: `Chart.yaml` ou `kustomization.yaml|yml`; arquivo `PROJECT` de kubebuilder/operator-sdk; YAML com `apiVersion:` e `kind:` no topo (inclui CRDs); pastas `k8s/`, `deploy/`, `manifests/` ou `charts/` com YAML dentro; arquivos de teste (`*.test.*`, `*.spec.*`, `*_test.*`, `test_*`, `e2e/`, `tests/`) que citam `kubectl`, `KUBECONFIG`, `@kubernetes/client-node` ou `envtest` (menos os testes do próprio detector, `needs-cluster*`). Ignora `node_modules`, `.git`, `.worktrees` e `vendor`.
- Limites: heurística por texto. Um YAML não-k8s com `apiVersion`+`kind` no topo causa falso positivo (use `off`); manifests gerados em tempo de build não são vistos (use `kind`). A saída explica o motivo: `ci/needs-cluster.sh [dir]`.

### Release manual e gatilhos dos workflows

O fluxo `staged` dos PRs `router/*` exige liberação manual. `release({})` liga o runner e dispara o workflow. Para dispará-lo diretamente com `gh`, garanta que o runner esteja ligado (via `ci/runner-up.sh owner-repo`) e execute no repositório alvo:

```bash
gh workflow run router-release.yml
```

Os gatilhos versionados são:

| Workflow | Gatilho | Execução |
| --- | --- | --- |
| [router-release.yml](.github/workflows/router-release.yml) | Somente manual (`workflow_dispatch`) | Runner self-hosted; compara, testa e mergeia PRs `router/*`. |
| [router-cloud.yml](.github/workflows/router-cloud.yml) | Somente manual (`workflow_dispatch`) | Runner hospedado; **esqueleto incompleto**, sem execução ponta a ponta comprovada. |
| [router-verify.yml](.github/workflows/router-verify.yml) | Somente manual (`workflow_dispatch`) | Runner self-hosted; verifica `inputs.ref` contra `inputs.base` (padrão `main`). |

Todos os workflows são manuais (`workflow_dispatch`); nenhum dispara por `push` ou `pull_request`. Para verificar um branch: `gh workflow run router-verify.yml -f ref=release/alpha -f base=main`.

O modo `pr` depende de checks efetivamente disparados no repositório alvo; neste repositório, `router-verify` precisa ser acionado manualmente. Para gate local seguido de liberação manual, use `staged`.

## Documentação e limites atuais

- [Arquitetura](ARQUITETURA.md) — inclui o desenho original e intenções futuras; nem tudo do diagrama está implementado.
- [Fluxo completo do roteamento e execução](docs/fluxo-completo.md).
- [Pesquisa sobre agentes em paralelo](docs/research/agentes-em-paralelo.md).
- [Pesquisa sobre plugins de agentes](docs/research/plugins-agentes.md).
- [Decomposição multi-tarefa](docs/multi-task-plan.md).
- [Política de modelos, preços e sandbox](docs/model-policy.md).
- [Verificação staged](docs/staged-verify-design.md) — a revisão no início atualiza o desenho para release manual.
- [Validação e smoke manual](docs/e2e-smoke.md) — resultados observados e procedimento com modelos reais.
- [Integração Codex](docs/codex-implementation-plan.md).
- [Integração de subprocessos e stdio](docs/exec-integration-plan.md).
- [Instruções para contribuidores e agentes](AGENTS.md).

Os testes usam subprocessos simulados e Git real em repositórios temporários, sem chamar modelos pagos. O teste de handshake MCP usa processos reais e cobre inicialização, listagem de ferramentas e `status`, fora da pasta da instalação, com stdin bloqueante ou não bloqueante e dependências locais ou em um ancestral. Isso não comprova conexão pelo cliente Claude Code nem um ciclo completo de implementação/revisão com modelos reais; veja os resultados e limites em [docs/e2e-smoke.md](docs/e2e-smoke.md).

O modo nuvem ainda depende de integração do banco, instalação dos CLIs e acionamento da verificação. Importadores de sessão e adaptadores Zed/Antigravity permanecem fora da implementação atual.

## Roadmap — planejado

Os itens abaixo são próximos passos, não funcionalidades entregues:

- **Adapters automáticos:** automatizar a integração de adaptadores; hoje o registro é explícito em `src/adapters/registry.ts`.
- **Roteamento implícito:** encaminhar pedidos sem exigir a chamada explícita de `route`; hoje o hook de prompt apenas registra mensagens no banco.

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE).
