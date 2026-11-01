# LLM-Router

Router MCP por **stdio**, em TypeScript, que faz triagem (`triage`), planejamento (`plan`) e roteia tarefas de programação para Claude Code e Codex CLI, escolhendo modelo, categoria (`tier`: `cheap`, `mid`, `strong`) e esforço por fase. Executa passos em worktrees Git e registra estado, tentativas e uso em SQLite.

O uso pretendido por enquanto é com Claude Code e Codex, **com Grok desativado**. Isso exige definir `enabled: false` em `models.grok-fast` e `models.grok-reasoning` no catálogo usado pelo servidor: o [YAML versionado](config/router.yaml) ainda os habilita por padrão. O adaptador `grok-build` continua registrado, e o transporte do Grok Bot ainda não foi configurado.

Os trabalhadores abrem sessões novas, com modelo e esforço explícitos, sem alterar o modelo da conversa que chamou o MCP. As preferências atuais são Opus para planejamento, Sol para implementação e Astra para integração/revisão, com alternativas da mesma categoria. São hipóteses de configuração, ainda sem benchmark comparativo local. Terra permanece desativado.

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
| `route` | `request`, `override_tier?` | Classifica a fase, cria a tarefa e retorna `task_id`, tier, modelo, adaptador, esforço e `next` (`plan`, `run` ou `wait`). Inclui diretriz e fonte de preço quando disponíveis. |
| `plan` | `task_id` | Usa um modelo forte para dividir a tarefa em passos com briefs, arquivos, categorias e dependências. |
| `run_plan` | `task_id` | Inicia os passos em segundo plano e retorna os números dos passos iniciados e aguardando dependências. |
| `status` | `task_id?` | Retorna custos agregados; com ID, inclui tarefa, passos e tentativas. |
| `check_models` | `{}` | Faz ping dos modelos habilitados e grava disponibilidade e estado de cota. |
| `relay` | `body`, `task_id?` | Tenta enviar uma mensagem ao Grok Bot; com o transporte atual indisponível, registra fallback para o canal Claude e retorna `delivered: false`. |
| `release` | `sync_only?` | Sinaliza a liberação dos PRs staged pelo workflow; com `sync_only: true`, apenas sincroniza o estado local com o GitHub. |

Fluxo habitual:

1. Chame `route({request: "..."})`.
2. Se `next` for `plan`, chame `plan({task_id: "..."})`. Tarefas `cheap`/`mid` já recebem um passo único; `wait` indica ausência de modelo disponível.
3. Chame `run_plan({task_id: "..."})` e acompanhe `status({task_id: "..."})`.
4. No modo `staged`, os PRs aguardam `release({})`. Depois, `release({sync_only: true})` permite atualizar o estado local se necessário.

Os custos misturam dados devolvidos pelos CLIs e estimativas do catálogo. Não são fatura nem saldo da assinatura; `status` informa `billing_verified: false`.

## Configuração

[config/router.yaml](config/router.yaml) define modelos, preços e fontes, triagem, categorias, preferências por fase (`phases.<fase>.prefer`), escadas de esforço e verificação. Modelos com `enabled: false` não são selecionados nem pingados. Preferências dependem da disponibilidade local; falta de cota permite fallback na mesma categoria.

| Variável | Função |
| --- | --- |
| `ROUTER_CONFIG` | Caminho de um catálogo alternativo; o padrão vem da instalação. |
| `ROUTER_DB` | Caminho do SQLite; use um por projeto. |
| `ROUTER_REPO_DIR` | Repositório alvo; padrão: diretório de trabalho do processo. |
| `ROUTER_BASE` | Branch base; padrão: `main`. |
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
```

### Verificação e push de branches

| Modo | Verificação | Resultado |
| --- | --- | --- |
| `local` | Comandos locais em sequência no worktree; falha retorna ao agente com a saída. | Com `auto_merge: true`, rebase na base local e fast-forward no checkout do projeto. Sem fetch, push, PR ou GitHub. |
| `pr` | Publica branch e PR e acompanha os checks do GitHub. | Pode fazer merge após checks verdes e remover o branch conforme a configuração. |
| `staged` | Fetch, rebase em `origin/<base>` e comandos locais antes de publicar. | Gate verde faz push e abre PR; passo fica `pr_open` e tarefa `awaiting_release`. CI e merge aguardam `release`. |

O catálogo atual omite `verify.mode`, cujo padrão é `pr`. Os modos `local` e `staged` exigem `verify.local.cmds`. No `local`, o checkout alvo precisa estar no branch base para o merge automático; com `auto_merge: false`, o resultado permanece no branch/worktree para revisão. No `pr`, essa opção mantém o PR aberto após checks verdes. No `staged`, quem faz o merge é o workflow de release; `verify.auto_merge` não controla essa etapa.

No modo `local`, os testes rodam antes do rebase e não são repetidos depois dele.

Cada passo usa um branch `router/step-*` e worktree em `.worktrees/`. **`run_plan` pode publicar alterações**: nos modos `pr` e `staged`, o push usa `git push -u --force-with-lease origin <branch>` para publicar ou atualizar o branch do passo após rebases. No `staged`, falha no gate local impede push e criação do PR. Passos dependentes podem partir do branch de um PR ainda aberto.

O release compara os PRs abertos com prefixo `router/`, verifica cada um sobre a base atualizada, faz merge por rebase dos verdes e remove seus branches remotos. PRs com falha ficam abertos; dependentes de um PR que não passou são pulados. A sincronização marca passos mergeados como `done` e remove seus worktrees e branches locais.

## CI, runner e cluster

O CI de verificação e release usa runner **self-hosted** com labels `[self-hosted, router-ci]`. [ci/runner-install.sh](ci/runner-install.sh) registra um runner por repositório (`ci/runner-install.sh owner/repo`), com `gh` autenticado e permissão administrativa. Os scripts usam serviços de usuário do systemd; o runner também precisa de `kind`, `kubectl` e ambiente capaz de criar o cluster.

O router liga o runner sob demanda durante a verificação/release. [ci/pr-ci.sh](ci/pr-ci.sh) instala dependências, sobe ou reaproveita o cluster kind `router-ci`, compara falhas de testes com a base estável e executa o typecheck. Ao terminar, [ci/runner-down.sh](ci/runner-down.sh) desliga o runner e remove o cluster quando não há CI em execução ou na fila dos repositórios registrados. `KIND_CLUSTER` permite mudar o nome do cluster.

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
| [router-verify.yml](.github/workflows/router-verify.yml) | Automático (`pull_request`), com job que ignora branches `router/*` | Runner self-hosted; verifica os demais PRs. |

Portanto, o release dos PRs do router é manual, mas os workflows do repositório **ainda não são todos manuais**.

O modo `pr` depende de checks efetivamente disparados no repositório alvo; neste repositório, `router-verify` ignora os PRs do router. Para gate local seguido de liberação manual, use `staged`.

## Documentação e limites atuais

- [Arquitetura](ARQUITETURA.md) — inclui o desenho original e intenções futuras; nem tudo do diagrama está implementado.
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

- **Decomposição multi-tarefa:** ampliar a divisão do pedido em tarefas coordenadas; hoje o planejador divide uma tarefa em passos com dependências e arquivos.
- **Reparo pontual antes de escalar:** corrigir a falha específica antes de subir modelo/esforço; hoje a falha volta ao agente pela escada configurada.
- **Adapters automáticos:** automatizar a integração de adaptadores; hoje o registro é explícito em `src/adapters/registry.ts`.
- **Roteamento implícito:** encaminhar pedidos sem exigir a chamada explícita de `route`; hoje o hook de prompt apenas registra mensagens no banco.

## Licença

GPL-3.0-or-later.
