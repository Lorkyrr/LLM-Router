# Cooperação Claude Code, Codex e Grok

## Objetivo e evidência

Avaliação de 2026-10-31 solicitada pelo usuário: distribuir tarefas por modelo, definir coordenação, colaboração e concorrência antes da integração com o Grok-Bot. Este documento é uma proposta operacional; não altera a configuração nem comprova superioridade entre modelos.

Fontes locais: `config/router.yaml`, `docs/model-policy.md`, `src/adapters/`, `src/runner/run-plan.ts`, `src/runner/run-step.ts`, `src/git/branch.ts` e `src/verify/ci.ts`. O grafo existente foi consultado como mapa; as limitações abaixo foram conferidas no código atual.

Claude Code 2.1.314 está instalado; `claude auth status` informou autenticação por assinatura Pro. A primeira consulta usou o adaptador real do projeto com `claude-opus-5-5`, esforço `high`, somente leitura e timeout de 120 segundos. Terminou com `ok: false`, `exit 124`, sem resposta utilizável. Logo, não houve debate concluído nem aprovação do Claude. O retorno com tokens zerados e custo `null` não prova consumo zero: o processo pode ter consumido recursos antes do timeout.

Uma segunda consulta, curta e sem ferramentas, usou `claude-haiku-5-5` em `low` com timeout de 45 segundos e teve o mesmo resultado (`exit 124`). Não houve resposta inferencial comprovada em nenhuma tentativa; autenticação local não prova acesso ao serviço. Não foram tentados novos modelos ou remoção de isolamento. Validação local: `npm test` terminou com 27 testes reportados, 27 passando e zero falhas; `npm run typecheck` terminou com código 0.

### Teste de desenvolvimento conjunto da fila

Em nova solicitação do usuário, Claude Sonnet 5.5 em `medium` recebeu a responsabilidade de revisar `src/runner/run-plan.ts` e seus testes, propondo uma correção pequena; Codex ficou responsável pelo teste de regressão e implementação após avaliar a resposta. A chamada foi feita pelo adaptador real, em leitura, sem publicação, com timeout de 45 segundos. Resultado: `ok: false`, `exit 124`, sem resposta. A divisão foi enviada como prompt ao processo local, mas não há confirmação de recebimento pelo serviço ou trabalho realizado pelo Claude.

Diagnóstico independente com `socket.getaddrinfo`: tanto `api.anthropic.com` quanto `claude.ai` retornaram `gaierror [Errno -3] Temporary failure in name resolution`. Esse bloqueio de DNS impede comprovar comunicação externa neste ambiente; não permite concluir que o adaptador ou o modelo sejam incompatíveis. Nenhum isolamento foi removido. Os testes locais do adaptador Claude e do agendador passaram (runner reportou dois arquivos passando), e o typecheck terminou com código 0. Esses testes usam execução simulada e não comprovam inferência remota. Nenhuma mudança na fila foi atribuída ao Claude ou implementada como se houvesse colaboração concluída. Retomar a mesma divisão em ambiente com conectividade antes de declarar integração ponta a ponta.

## Responsabilidade por tarefa

As escolhas abaixo são hipóteses do catálogo atual, a validar com tarefas representativas. Disponibilidade de binário, autenticação, acesso ao modelo e qualidade são verificações diferentes.

| Tarefa | Primeira escolha | Alternativa | Entrega e limite |
|---|---|---|---|
| Classificar pedido e extrair campos | Haiku 5.5 low | Luna low | Categoria, fase e ambiguidades; sem decidir arquitetura |
| Edição trivial e isolada | Haiku 5.5 low | Luna low | Mudança pequena e verificação correspondente |
| Planejar mudança com dependências | Opus 5.5 high | Astra high | Contratos, arquivos, dependências, critérios de aceite e briefs |
| Implementar plano e testes | Sol medium | Sonnet 5.5 medium | Diff mínimo e resultados de checks; high se houver dificuldade demonstrada |
| Investigar causa raiz complexa | Astra high | Opus 5.5 high | Hipótese, reprodução e evidências antes da correção |
| Integrar partes com contratos difíceis | Astra high | Opus 5.5 high | Compatibilidade entre partes e validação conjunta |
| Revisar implementação delimitada | Sonnet medium se Sol escreveu; Sol medium se Sonnet escreveu | Astra/Opus high para risco complexo | Achados verificáveis, com arquivo e impacto; não reescrever por preferência |
| Visão, interface ou escrita especializada | Terra desativado | Selecionar modelo disponível e validar capacidade necessária | Não habilitar Terra sem teste específico de acesso e qualidade |
| Execução via Grok Build | grok-fast ou grok-reasoning, conforme categoria | Fallback configurado na mesma categoria | Sem especialidade presumida; precisa da mesma avaliação local |
| Conversar com o usuário via Grok-Bot | Bot como ponte | Canal atual | Receber pedido e devolver estado; não confundir com Grok Build |

Revisão delimitada cruzada é proposta manual, não preferência já implementada em `full_review`. Hoje essa fase prefere Astra e depois Opus. Não duplicar planejamento ou revisão em toda tarefa simples.

## Quem coordena quem

Há um coordenador responsável pelo objetivo, orçamento de tentativas, dependências e aceite. A conversa atual pode exercer esse papel; chamar um trabalhador não muda o modelo desta conversa. Claude também pode ser coordenador em uma sessão própria que disponha das ferramentas do router.

- Claude coordena Codex quando mantém o contexto e os requisitos: entrega planejamento ou diagnóstico ao Sol e avalia a evidência devolvida.
- Codex coordena Claude quando mantém o contexto e a execução: pede planejamento ao Opus ou revisão delimitada ao Sonnet, confronta os achados com código e checks e decide os próximos passos.
- A escolha depende da continuidade do contexto e do acesso às ferramentas, não de hierarquia fixa entre fornecedores. Uma análise melhor pode justificar transferir a coordenação, com handoff explícito.
- Um trabalhador não cria outro coordenador, não redistribui tarefas por conta própria e não chama o router recursivamente. Divergências voltam ao coordenador com evidências.
- Autorizações para editar, publicar ou executar ações destrutivas não são herdadas implicitamente. Esta avaliação autoriza consultas e documentação; não autoriza PR, push ou merge.

## Juntos, em paralelo e concorrentes

**Sequencial:** especificar contrato → implementar → executar checks → revisar quando o risco justificar → integrar. Serializar tarefas que alteram o mesmo contrato, migration, lockfile ou estado externo. O revisor recebe um snapshot identificado; novos commits invalidam conclusões afetadas.

**Paralelo complementar:** Sol implementa um módulo e Sonnet outro somente após fixar o contrato comum. Cada tarefa recebe dono, arquivos permitidos e worktree próprio. Ambos são informados de que há outros agentes e devem preservar alterações alheias. Um terceiro trabalho pode revisar um snapshot estável em leitura, sem editar os arquivos em implementação. Checks conjuntos vêm depois da integração.

**Concorrente competitivo:** duas hipóteses ou soluções para o mesmo problema, em branches isoladas e no mesmo commit-base. Usar apenas quando a incerteza justificar duplicar consumo; não como padrão. Mesmo brief, critérios e limite de tentativas. Preferir primeiro diagnósticos em leitura. Comparar correção, testes, regressões, tempo e consumo total; escolher uma solução e integrar conscientemente qualquer parte útil da outra. Não fazer dois merges automáticos de soluções rivais.

`runPlan` já agenda passos independentes por promessas e respeita `depends_on`; `startBranch` cria worktree por passo a partir de `origin/<base>`. Isso não detecta colisões de arquivos, não limita concorrência global e não implementa competição com escolha de vencedor. Passos dependentes esperam o anterior terminar, incluindo seu fluxo de merge. Paralelismo seguro exige briefs e dependências corretos; worktree sozinho não resolve conflitos semânticos.

## Compatibilidade e limites

| Aspecto | Compatibilidade atual | Regra operacional |
|---|---|---|
| Transporte | Claude retorna JSON; Codex JSONL; adaptadores normalizam `RunResult` | Não passar a saída bruta de um CLI ao parser do outro |
| Modelo e esforço | Enviados explicitamente em cada tentativa | `medium` não garante o mesmo custo, raciocínio ou latência entre fornecedores; validar cada combinação |
| Contexto | Sessões novas; Claude sem persistência e Codex efêmero | Repassar brief e evidência necessária; não pressupor memória compartilhada |
| Ferramentas | Claude em leitura recebe Read/Glob/Grep; em escrita inclui Bash; Codex usa sandbox read-only/workspace-write | Consulta Claude em leitura não executa testes; o coordenador fornece a saída dos checks |
| Permissões | Claude usa `acceptEdits`; Codex usa `approval_policy=never` preservando sandbox | Não equivalem entre si; disponibilidade de ferramentas não comprova permissão ou acesso à rede |
| Configuração | Claude restringe fontes a project e MCP; Codex ignora config global | Não presumir herança de plugins, skills ou MCPs da sessão coordenadora |
| Disponibilidade | Ping testa uma resposta curta em low | Não comprova execução longa, esforço high, ferramentas ou qualidade; testar o caminho real |
| Custos | Claude pode informar custo; Codex é estimado pelo catálogo | Somar coordenador, tentativas, triagem, planejamento e revisão; o status atual não captura tudo nem confirma fatura |
| Falha | Timeout, erro de parser, cota e indisponibilidade têm causas diferentes | Não classificar timeout como modelo ruim nem repetir indefinidamente; manter consumo desconhecido como desconhecido |

Referências oficiais consultadas em 2026-10-31: [Codex não interativo](https://learn.chatgpt.com/docs/non-interactive-mode) e [esforço Claude](https://platform.claude.com/docs/en/build-with-claude/effort). Documentação de produto não substitui teste da conta e da versão instalada. Não foram revalidados todos os preços ou IDs do catálogo nesta avaliação.

## O que precisa existir antes da automação completa

1. Um caminho de consulta/revisão sem exigir alterações Git. Hoje usar adaptador em leitura fora de `run_plan`; isso não cria histórico de tentativa no banco automaticamente.
2. Separar execução, publicação e merge com autorização explícita. `verify.auto_merge` não é consultado pelo fluxo atual de `runStep`/`verifyAndMerge`; configurar false não é uma barreira de segurança. Não executar `run_plan` para esta avaliação ou para competição de soluções.
3. Para competição automática, adicionar comparação e seleção antes de publicar; para paralelismo amplo, limitar concorrência e verificar sobreposição de responsabilidade. São propostas, não funcionalidades entregues.
4. Avaliar os pares com os mesmos briefs e commit-base, sem publicação: triagem, mudança delimitada, bug com reprodução, revisão com defeito conhecido e integração entre módulos. Registrar sucesso, regressões, latência, tokens conhecidos/desconhecidos e custo total das tentativas. Só então alterar preferências.

## Próxima tarefa: integração Grok-Bot

### Direção confirmada: Grok coordenador no PC

O usuário esclareceu que o Grok deve coordenar Claude Code e Codex pelo MCP local, podendo usar o terminal. Grok Build 1.0.70 está instalado e oferece `grok mcp add/list/doctor`. Em 2026-10-31, o registro de usuário existente `llm-router` em `~/.grok/config.toml` foi atualizado para `python3 /home/mateus/Documentos/Coding/LLM-Router/bin/router-mcp.py`, com `ROUTER_CHECK_MODELS=manual`. `grok mcp list` confirmou o launcher. Isso configura o cliente, mas não comprova inferência ou coordenação ponta a ponta.

Fluxo pretendido: usuário → Grok coordenador → MCP local → adaptadores Claude Code/Codex → resultados → Grok. Abrir `grok` no repositório-alvo mantém o contexto de trabalho; para vários projetos, definir um `ROUTER_DB` separado por projeto conforme o README. Os processos executam no PC, enquanto os modelos remotos ainda exigem conectividade. Grok coordenador e Grok Build trabalhador são papéis distintos mesmo quando usam o mesmo executável; impedir que o trabalhador volte a despachar recursivamente pelo router antes de automatizar esse caminho. `run_plan` ainda tem os riscos de publicação e merge descritos acima.

Validação real: `grok mcp doctor llm-router --json` retornou `healthy: true`, processo iniciado, handshake OK (protocolo `2025-11-25`) e seis ferramentas descobertas. Portanto a conexão Grok cliente → MCP local está comprovada. Chamadas aos modelos e o desenvolvimento conjunto permanecem sem validação por causa das falhas de conectividade registradas acima.

### Nova tentativa de coordenação e chamada efetiva do MCP

Teste de 2026-10-31 com marcador `ROUTER-COORD-01`, pedindo confirmação e uma divisão mínima para a feature de Grok coordenar Claude e Codex localmente. Nenhum agente foi autorizado a editar, delegar ou publicar neste diagnóstico.

| Agente | Modelo solicitado | Esforço solicitado | Duração observada | Resultado |
|---|---|---|---|---|
| Claude Code | `claude-sonnet-5-5` | `medium` | 20.043 ms | Timeout `exit 124`, sem resposta ou confirmação do modelo/esforço efetivos |
| Grok Build | `grok-4.7-build-fast` | `low` | 3.086 ms | `unknown model id`; CLI informou que ignorou o esforço |
| Grok Build, nova tentativa | `grok-4.6` | `low` | 15.036 ms | Timeout `exit 124`, stdout/stderr vazios; esforço efetivo não confirmado |

Consumo e custo dessas tentativas são desconhecidos. O catálogo configurado não equivale ao catálogo acessível à conta. `grok models` informou sessão autenticada por grok.com e listou `grok-4.6` (default) e `grok-4.5`, acompanhado de erros `Settings fetch failed`; a lista pode refletir fallback/cache. Isso atualiza o diagnóstico anterior de ausência de login, sem provar acesso remoto funcional. Não se alteraram os IDs de `config/router.yaml` com base nessa lista incompleta.

O coordenador chamou efetivamente `status({})` por um cliente SDK MCP conectado ao launcher Python, usando banco temporário isolado e `ROUTER_CHECK_MODELS=manual`. O servidor respondeu `isError: false` com custos vazios e `billing_verified: false`; cliente e banco temporário foram encerrados/limpos. Esse teste comprova chamada e resposta de ferramenta local, além de descoberta e handshake, mas não uma chamada MCP feita por Claude ou Grok nem colaboração inferencial. O DNS local continuou falhando para `api.anthropic.com`, `api.x.ai` e `auth.x.ai`.

Brief proposto para retomada: Grok mantém pedido, dependências e comunicação; Claude revisa o contrato de execução sem publicação e os riscos de recursão; Codex escreve teste de regressão e implementação mínima após o contrato. Primeiro provar uma consulta de leitura com modelo/esforço e uso registrados; depois habilitar edição local controlada. Não tratar essa proposta como acordo dos agentes enquanto não responderem.

Solicitada pelo usuário após concluir esta avaliação. Manter Grok-Bot como ponte e Grok Build como adaptador de execução. Primeiro levantar interface real, autenticação e canal de mensagens; não presumir plataforma ou protocolo. Planejar recebimento, identidade de conversa/projeto, despacho MCP, acompanhamento e resposta, com proteção contra mensagens duplicadas e exposição de segredos.

Divisão proposta: Opus planeja o contrato e os casos de erro; Sol implementa o transporte e seus testes; Sonnet revisa o diff e os limites de entrada; Astra é reservado para dúvidas de arquitetura e integração complexa. Tarefas independentes só começam após o contrato estar definido. Se Claude continuar inacessível, registrar o bloqueio e prosseguir com as partes independentes sem atribuir trabalho ou concordância fictícios a ele.
