# Agentes em paralelo no LLM-Router

Consulta: **2026-11-01 (UTC)**. Pesquisa em fontes oficiais; **proposta** identifica decisões para implementação futura. **Não confirmado** significa que a documentação consultada não estabelece a propriedade. Nenhum agente pago, serviço de nuvem ou orquestrador foi iniciado nesta pesquisa.

## Opções e compromisso principal

| Alternativa | Vantagem | Limitação / isolamento | Cancelamento | Custo |
| --- | --- | --- | --- | --- |
| Processos headless pelo router | Mesma fila para vários fornecedores; controle de tentativa/PID | Exige supervisor; worktree separa arquivos, não credenciais/processos | Grupo de processos/cgroup com prazo | Contexto e inferência por tentativa; testes usam CPU/RAM |
| Subagentes/SDK nativos | Delegação, contexto e eventos integrados | Vinculados ao fornecedor; contexto separado não implica filesystem separado | API/UI específica; verificar descendentes | Soma pai + filhos + síntese; sem desconto automático por paralelismo |
| Zed/ACP | Vários agentes acessíveis pela mesma interface | Protocolo cliente-agente; scheduler global não confirmado | `session/cancel`, conforme adapter | Provedor do agente cobra; ACP não é modelo |
| LangGraph/CrewAI/Agents SDK | Fluxos, ferramentas e coordenação reutilizáveis | Integração com CLIs/worktrees precisa de adapters | Runtime + supervisor externo | Chamadas de gestão/delegação e possíveis serviços adicionais |
| GitHub Actions matrix | Distribuição por jobs e artefatos; execução remota | Runners/credenciais e limites da conta | Cancelar run/job; limites de tempo | Inferência + minutos/armazenamento do runner conforme plano |
| systemd-run em host/VM | Cgroups, journal e ciclo de vida gerenciado | Linux/systemd; fila durável é responsabilidade adicional | `systemctl stop` da unidade | Inferência + host/VM; não fornece modelos |

A tabela sintetiza as fontes abaixo; avaliações de adequação e arquitetura são propostas, sem benchmark local.

## 1. Router como supervisor de processos headless

Os três comandos básicos estão confirmados: [Claude programático](https://code.claude.com/docs/en/headless), [Codex não interativo](https://developers.openai.com/codex/noninteractive), [Grok headless](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md).
Exemplos de invocação (não executar simultaneamente na mesma árvore; modelos são variáveis, não escolhas de catálogo):

```sh
claude -p "Tarefa delimitada" --model "$CLAUDE_MODEL" --output-format json
codex exec --model "$CODEX_MODEL" --json "Tarefa delimitada"
grok -p "Tarefa delimitada" --model "$GROK_MODEL" --output-format json
```

**Proposta de execução:** cada processo recebe `cwd` de worktree exclusiva e argv sem shell, política de ferramentas/sandbox e ambiente mínimo. Modelo e esforço ficam registrados explicitamente por tentativa; validar suporte do esforço em cada adapter. Manter fallback na categoria configurada; não copiar flags que desabilitam isolamento.

1. Criar tarefa/attempt no armazenamento com lease; criar branch/worktree por tentativa a partir de SHA definido: `git worktree add -b feature/<tarefa>-<tentativa> <diretorio> <sha>`. Não reutilizar branch já ativa. Worktrees têm checkout/índice próprios, mas compartilham objetos e parte do estado Git. [Git oficial](https://git-scm.com/docs/git-worktree).
2. Definir propriedade dos arquivos, entradas e critério de conclusão antes do fan-out. Dependências entre tarefas formam DAG: só liberar sucessoras quando artefatos/pré-condições forem validados. Integração e testes finais são serializados; conflitos não devem ser resolvidos por dois agentes na mesma árvore.
3. Reservar slot global e por fornecedor/conta antes de spawn; coordenar entre instâncias MCP por armazenamento compartilhado/lease. **Inicial sugerido, sem medição:** dois processos globais e um por fornecedor; aumentar após medir RSS, CPU, latência e rate limit. Não multiplicar o limite por cliente MCP conectado.
4. CPU/RAM: orçamento inclui CLI, MCPs e ferramentas descendentes (build/testes), não só o processo pai. Em Linux, cgroup por tentativa com `CPUQuota`, `MemoryHigh`, `MemoryMax` e `TasksMax`; manter margem para SO/router. Um semáforo limita quantidade, não consumo real. [Controle de recursos systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html).
5. Rastrear `task_id`, `attempt_id`, fornecedor/modelo/esforço, SHA/worktree, PID, PGID/cgroup, instante UTC de início, identidade do processo, session/thread ID, heartbeat, deadline, código/sinal de saída e logs privados. PID isolado pode ser reciclado; reconciliar identidade após reinício e não matar processos só por número persistido.
6. Capturar stdout estruturado e stderr separadamente, drenar ambos e limitar volume; encaminhar eventos de progresso sem violar o contrato buffered atual de `Exec`. Persistir resultado só após saída/validação; um exit code zero não prova testes aprovados. A evolução do supervisor exige desenho próprio, sem afirmar que já existe no router.
7. Isolar DBs, portas, diretórios de build e arquivos temporários quando forem mutáveis. Worktree não é sandbox de segurança; manter as permissões de cada CLI e usar contêiner/VM quando exigir separação forte. Credenciais nunca entram em branch, log ou artefato. Bloquear autochamada recursiva do router nos agentes filhos.
8. Cancelar: marcar intenção durável, impedir novos filhos, solicitar parada nativa quando houver, enviar SIGTERM ao grupo/unidade e SIGKILL após prazo; aguardar/recolher todos os filhos, registrar estado terminal e liberar slot uma vez. Ferramenta remota pode continuar após matar CLI: reportar efeito pendente, sem prometer rollback.
9. Retentativas: somente para falhas transitórias classificadas, com backoff/jitter e orçamento máximo de tentativas/tempo/tokens; reconstruir contexto mínimo e preservar alterações para inspeção. Não repetir automaticamente ações externas com efeitos desconhecidos. Remover worktrees apenas segundo política explícita, preservando trabalho não integrado.

**Prós:** adaptação incremental aos três CLIs, responsabilidade clara por branch e controle independente do fornecedor. **Contras:** startup/contexto repetidos, auth/rate limits compartilhados, supervisor e integração Git ficam sob responsabilidade do router.

## 2. Recursos nativos

### Claude Code: subagentes, equipes e Agent SDK

Subagentes têm contexto e ferramentas próprios; definições em `.claude/agents/` ou `~/.claude/agents/`, invocadas pelo agente principal. A documentação permite execução foreground/background e `isolation: worktree`; arquivos separados precisam ser solicitados/configurados. [Subagentes oficiais](https://code.claude.com/docs/en/sub-agents).
O Agent SDK oferece definições programáticas de agentes e acompanhamento das mensagens; subagentes paralelos reduzem contaminação de contexto e retornam resultados ao pai. Adotar limites de turns/orçamento e cancelamento do SDK conforme versão, além do supervisor do host. [Subagentes no SDK](https://code.claude.com/docs/en/agent-sdk/subagents).
**Pró:** delegação e síntese integradas. **Contra:** pai, filhos e síntese consomem tokens; herança de ferramentas/permissões precisa de configuração. Cancelamento de toda a árvore de ferramentas externas e limites rígidos de CPU/RAM por subagente **não confirmados como garantia universal**; usar cgroup/VM.
Para coordenação entre sessões, avaliar também Agent Teams, conforme disponibilidade/limitações da versão; não assumir que subagente e equipe sejam o mesmo mecanismo. [Equipes oficiais](https://code.claude.com/docs/en/agent-teams).

### Codex: threads, subagentes e App Server

`codex app-server` oferece protocolo próprio com handshake `initialize`/`initialized`, `thread/start`, `thread/resume`, `thread/fork`, `turn/start` e eventos. `threadId`/`turnId` permitem correlacionar trabalho e `turn/interrupt` solicita cancelamento, concluindo como `interrupted`. Threads distintas podem atender tarefas distintas; associar cada uma a seu `cwd`/worktree. Esse handshake não é o handshake MCP. [App Server oficial](https://developers.openai.com/codex/app-server).
Subagentes nativos possuem configuração própria; a documentação atual apresenta `agents.max_concurrent_threads_per_session`, com `agents.max_threads` como alias legado. Um limite por sessão não substitui limite global de processos/contas do router. [Subagentes oficiais](https://developers.openai.com/codex/multi-agent).
**Pró:** progresso, retomada e cancelamento estruturados, com menos parsing de texto. **Contra:** gerenciar eventos, aprovações e compatibilidade da versão. Fork de conversa não cria automaticamente worktree/VM. Limites de CPU/RAM por thread e execução em nuvem pelo simples uso de app-server **não confirmados**.

### Grok Build: subagentes e sessões headless

O guia oficial confirma sessões filhas paralelas com contexto próprio e resumo ao pai; agentes em `.grok/agents/`/`~/.grok/agents/`, gerenciamento por `/agents` e painel de tarefas `Ctrl+G` para inspecionar/encerrar. A herança MCP pode ser restringida por `mcpInheritance`. [Subagentes oficiais](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md).
Headless aceita `grok -p`; JSON inclui `sessionId`; `--resume` continua sessão, enquanto `--session-id` cria nova sessão UUID. [Headless oficial](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md).
**Pró:** delegação paralela já suportada pelo produto. **Contra:** não foi confirmada no guia uma garantia de worktree/cgroup separado por filho nem API estável de cancelamento remoto de toda a árvore. Não inferir essas propriedades do contexto separado. Para controle uniforme, começar com processos headless supervisionados.

### Zed e ACP

Zed hospeda threads de agentes externos, cada qual com runtime, autenticação e seleção de modelo próprios; pode encaminhar MCP. ACP padroniza comunicação cliente-agente, não converte MCP em fila distribuída. [Agentes externos](https://zed.dev/docs/ai/external-agents), [MCP](https://zed.dev/docs/ai/mcp).
**Pró:** interface comum e inspeção com `dev: open acp logs`. **Contra:** paralelismo efetivo e suporte de cada adapter precisam ser validados; scheduler global com cotas CPU/RAM/worktrees **não confirmado no Zed**. O protocolo define `session/cancel`; o efeito nas ferramentas descendentes continua dependente do agente. [Cancelamento ACP](https://agentclientprotocol.com/protocol/prompt-turn).
Zed declara não cobrar por External Agents; a relação de cobrança é com o fornecedor do agente. Isso não torna inferência gratuita nem descreve a cobrança dos modelos hospedados pelo próprio Zed. [Cobrança de agentes externos](https://zed.dev/docs/ai/external-agents).

### Orquestradores existentes

- **LangGraph:** execução com estado, persistência e interrupções humanas; adequado a DAGs/retomada. Integração dos CLIs e cancelamento de processos requerem ferramentas próprias; persistência do grafo não desfaz alterações externas. [Documentação oficial](https://docs.langchain.com/oss/python/langgraph/overview).
- **CrewAI:** processos sequencial/hierárquico e recursos assíncronos; útil quando papéis/delegação são centrais. Gerente LLM adiciona chamadas; usar hierarquia não garante paralelismo, isolamento de arquivos ou controle de PID. [Processos oficiais](https://docs.crewai.com/en/concepts/processes).
- **OpenAI Agents SDK:** abstrações de agentes, ferramentas, handoffs e tracing; avaliar para fluxos programáticos. Não equivale a executar `codex exec`; transporte para CLIs, worktrees e cgroups continua sendo integração do router. [Visão oficial de agentes/SDK](https://developers.openai.com/api/docs/guides/agents).

**Avaliação:** esses frameworks podem substituir parte da coordenação, mas adicionar outro runtime agora aumenta manutenção. Compatibilidade pronta com os três CLIs, login de assinatura e cancelamento completo **não confirmada**; exigir spike antes de adoção.

## 3. Filas e execução em host/nuvem

### GitHub Actions matrix

Matrix cria jobs por combinação; `strategy.max-parallel` limita jobs e `fail-fast` controla cancelamento dos demais em falha. Para tarefas independentes, propor `fail-fast: false`, `max-parallel: 2`, `timeout-minutes` por job e `concurrency` para impedir duplicatas conforme política. [Matrix oficial](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations), [concorrência](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
**Proposta:** despachar um manifesto com SHA/task/attempt/modelo; cada job recebe checkout isolado, executa CLI headless, publica patch/log redigido/resultado e deixa integração em etapa única. Usar runner hospedado ou VM efêmera; self-hosted persistente exige limpeza, sandbox e cotas próprias, pois jobs não ganham isolamento forte automaticamente.
**Prós:** logs/artefatos e distribuição prontos. **Contras:** startup, rede, segredos e limites do plano; matrix é fan-out de workflow, não fila FIFO durável genérica. Não prometer conclusão em ordem ou retries exatamente uma vez.
Cancelar com UI/API ou `gh run cancel <run-id>`; reter associação tarefa→run/job e confirmar término. Minutos/armazenamento e tokens são custos separados. Login local de assinatura não é credencial CI automaticamente disponível. [Cancelamento](https://cli.github.com/manual/gh_run_cancel), [cobrança Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

### systemd-run em estação Linux ou VM

Cria serviço transitório gerenciado; não provisiona nuvem e não oferece sozinho fila persistente. Propor scheduler no router com armazenamento/leases; `systemd-run` apenas executa cada item admitido. [Manual oficial](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html).
Exemplo proposto para tarefa já admitida e worktree existente; caminhos e prompt são ilustrativos:

```sh
systemd-run --user --unit=router-tarefa-123 --collect \
  --working-directory=/ABS/worktrees/tarefa-123 \
  -p CPUQuota=200% -p MemoryHigh=3G -p MemoryMax=4G -p TasksMax=128 \
  -p RuntimeMaxSec=1800 -p KillMode=control-group \
  /ABS/claude -p "Tarefa delimitada" --output-format json
systemctl --user stop router-tarefa-123.service
```

`CPUQuota=200%` permite até o equivalente a dois CPUs; RAM e limites de processos valem para o cgroup. Valores são ponto de partida, sem benchmark. Controladores/delegação disponíveis precisam ser verificados no host. [Recursos](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html).
**Prós:** journal, acompanhamento de unidade e encerramento do grupo. **Contras:** dependência de Linux/systemd, ambiente/PATH/credenciais do serviço e sessão de usuário; avaliar linger para sobreviver ao logout. Registrar unidade/cgroup além de PID; copiar resultados antes da coleta da unidade. Sem garantia de desfazer efeitos externos. [systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html), [semântica de encerramento](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).

## Tokens, limites e recomendação

**Modelo de custo proposto:** somar uso reportado de entrada/saída/cache/raciocínio por tentativa, pai/filhos e síntese; respeitar o significado dos campos de cada fornecedor, sem somar raciocínio novamente se já incluído na saída. Não duplicar totais de sessão que já agregam filhos. Aplicar preço oficial com fonte/data somente quando o regime de cobrança permitir; uso ausente permanece `desconhecido`.
Paralelismo reduz tempo apenas para trabalho independente; pode aumentar contexto repetido, revisões e retrabalho. Assinatura tem limites compartilhados; tokens estimados não são fatura nem saldo. Cancelar não reembolsa automaticamente tokens já processados; cache/descontos não devem ser presumidos. **Sem estimativa monetária ou multiplicador universal confirmado nesta pesquisa.**
**Recomendação:** começar com supervisor de processos headless + uma worktree por tentativa, dois slots globais ajustáveis, limite por fornecedor, budgets e cancelamento do grupo. Em Linux, usar systemd/cgroups para limites reais. Preferir subagentes nativos para pesquisa/revisão dentro de uma tarefa; contabilizar filhos para evitar fan-out multiplicativo.
Adicionar App Server do Codex quando eventos/retomada justificarem a complexidade; manter ACP como interface de uso, não scheduler. Usar Actions matrix para lotes remotos/CI após validar credenciais, custos e artefatos; avaliar LangGraph apenas se DAG/retomada crescerem além do supervisor simples. Tudo isso é proposta de evolução, não capacidade comprovada atual do LLM-Router.
**Aceitação futura:** testar concorrência máxima, morte/reinício do supervisor, PID reciclado, timeout, encerramento dos netos, rate limit, conflito Git, orçamento e reconciliação de job remoto — primeiro com processos fake, depois smoke autorizado e contabilizado. Handshake MCP confirma transporte; não confirma paralelismo, execução em nuvem ou acesso a modelos.
