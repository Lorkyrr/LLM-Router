# Cooperação Claude Code e Codex

## Objetivo e evidência

Avaliação de 2026-10-31 solicitada pelo usuário: distribuir tarefas por modelo, definir coordenação, colaboração e concorrência. Este documento é uma proposta operacional; não altera a configuração nem comprova superioridade entre modelos.

Fontes locais: `config/router.yaml`, `docs/model-policy.md`, `src/adapters/`, `src/runner/run-plan.ts`, `src/runner/run-step.ts`, `src/git/branch.ts` e `src/verify/ci.ts`. O grafo existente foi consultado como mapa; as limitações abaixo foram conferidas no código atual.

Claude Code 2.1.314 está instalado; `claude auth status` informou autenticação por assinatura Pro. A primeira consulta usou o adaptador real do projeto com `claude-opus-5-5`, esforço `high`, somente leitura e timeout de 120 segundos. Terminou com `ok: false`, `exit 124`, sem resposta utilizável. Logo, não houve debate concluído nem aprovação do Claude. O retorno com tokens zerados e custo `null` não prova consumo zero: o processo pode ter consumido recursos antes do timeout.

Uma segunda consulta, curta e sem ferramentas, usou `claude-haiku-5-5` em `low` com timeout de 45 segundos e teve o mesmo resultado (`exit 124`). Não houve resposta inferencial comprovada em nenhuma tentativa; autenticação local não prova acesso ao serviço. Não foram tentados novos modelos ou remoção de isolamento. Validação local: `npm test` terminou com 27 testes reportados, 27 passando e zero falhas; `npm run typecheck` terminou com código 0.

### Teste de desenvolvimento conjunto da fila

Em nova solicitação do usuário, Claude Sonnet 5.5 em `medium` recebeu a responsabilidade de revisar `src/runner/run-plan.ts` e seus testes, propondo uma correção pequena; Codex ficou responsável pelo teste de regressão e implementação após avaliar a resposta. A chamada foi feita pelo adaptador real, em leitura, sem publicação, com timeout de 45 segundos. Resultado: `ok: false`, `exit 124`, sem resposta. A divisão foi enviada como prompt ao processo local, mas não há confirmação de recebimento pelo serviço ou trabalho realizado pelo Claude.

Diagnóstico independente com `socket.getaddrinfo`: tanto `api.anthropic.com` quanto `claude.ai` retornaram `gaierror [Errno -3] Temporary failure in name resolution`. Esse bloqueio de DNS impede comprovar comunicação externa neste ambiente; não permite concluir que o adaptador ou o modelo sejam incompatíveis. Nenhum isolamento foi removido. Os testes locais do adaptador Claude e do agendador passaram (runner reportou dois arquivos passando), e o typecheck terminou com código 0. Esses testes usam execução simulada e não comprovam inferência remota. Nenhuma mudança na fila foi atribuída ao Claude ou implementada como se houvesse colaboração concluída. Retomar a mesma divisão em ambiente com conectividade antes de declarar integração ponta a ponta.

## Contrato de cooperação v1

**Status em 2026-11-01: parcialmente implementado** no branch `feat/agent-cooperation` (testes com `fakeExec`, sem modelos pagos):

- Papel (`role`) na decomposição e no banco (`steps.role`). A seleção por papel em `src/planner/selection.ts` usa o mais barato capaz, só `claude-code`/`codex`, e já inverte para Opus antes de Astra (pendência A aplicada no código). Os nomes de papel seguem `ROLES` do código (`triage`, `simple_edit`, `planning`, `implementing`, `investigation`, `integration`, `review`, `full_review`, `specialized`), não os da tabela §1.
- Passagem de contexto: `run-plan.ts` grava `steps.handoff` (brief, diff, achados, autor, risco, revisão), e o dependente recebe esse JSON no prompt.
- Revisão cruzada só com risco: risco inferido por heurística (`riskFor` em `run-plan.ts`, não pelo planner). Sonnet revisa Codex e Sol revisa Claude, em leitura, antes do gate e da publicação. Reprovação → reparo pontual → nova revisão → escada.
- Paralelismo: passos independentes rodam juntos até `verify.max_parallel`.
- "Agent made no changes": verifica o gate em vez de escalar (§5).

Implementado: `acceptance`, `risk`/`risk_reasons` declarados e `awaiting_review` (step e task; sem revisor disponível, não satisfaz `depends_on`; a CLI sai com código 1). Não implementado: `output`, `review_of` (a revisão acontece dentro do passo, antes do merge) e saídas `brief`/`findings` read-only como subtarefas próprias. O restante desta seção continua sendo a proposta. Os pontos de código citados são os que vão mudar quando o contrato for aprovado: `src/triage/decompose.ts` (schema e prompt), `src/planner/planner.ts` (`storeItems`), `src/runner/run-plan.ts` (agendamento e revisão), além de `src/store/db.ts`/`repo.ts` e da ferramenta `status` em `src/server.ts`. A partir da aprovação, esta seção substitui a tabela "Responsabilidade por tarefa" abaixo, que fica como histórico.

### 1. Papéis

| Papel (`role`) | Fase em `router.yaml` | Categoria capaz | Esforço inicial | Acesso | Saída (`output`) |
|---|---|---|---|---|---|
| `classify` | `triage` | cheap | low | leitura | `brief` (categoria, fase, ambiguidades) |
| `trivial_edit` | `simple_edit` | cheap | low | escrita | `diff` |
| `plan` | `planning` | strong | high | leitura | `brief` |
| `implement` | `implementing` | mid | medium | escrita | `diff` |
| `root_cause` | nova fase `root_cause` (strong/high) | strong | high | leitura primeiro; escrita só em subtarefa `implement` seguinte | `findings` |
| `integrate` | `integration` | strong | high | escrita | `diff` |
| `review` | `full_review` | mid para risco delimitado; strong para risco de contrato/arquitetura | medium / high | leitura | `findings` |

O coordenador (a sessão que chama o router) não é um papel de subtarefa. Trabalhadores não chamam o router de forma recursiva, não criam subtarefas novas nem redistribuem trabalho; divergências voltam ao coordenador junto com as evidências.

### 2. Campos da subtarefa

Hoje `Subtask` tem `phase, tier, effort, brief, depends_on, files, reason`. O contrato acrescenta:

| Campo | Tipo | Regra |
|---|---|---|
| `role` | um dos 7 papéis | Obrigatório. A `phase` é derivada do papel (tabela acima), não o contrário |
| `depends_on` | `number[]` (seq de itens anteriores) | Igual ao atual: só aponta para itens anteriores. `fileDependencies` continua serializando itens que compartilham arquivos |
| `files` | `string[]` | Arquivos permitidos. Para `diff`, mexer em arquivos fora da lista é achado de revisão, não erro do gate |
| `acceptance` | `string[]`, mínimo 1 | Critérios verificáveis (um comando, teste ou comportamento observável). Sem critério, o plano é inválido e o planner tenta de novo (limite atual de 2 tentativas) |
| `output` | `"brief" \| "diff" \| "findings"` | Define o modo: `brief` e `findings` rodam com `readOnly: true` e sem branch/merge; `diff` segue o fluxo atual de `runStep` |
| `risk` | `"low" \| "high"` | Ver §4. Se o planner não informar, vale `low`, a menos que uma regra objetiva da §4 aponte `high` |
| `risk_reasons` | `string[]` | Obrigatório quando `risk = high` |
| `review_of` | `number \| null` | Só em subtarefas `review`: seq da subtarefa revisada. É gerado pelo `storeItems`, nunca pelo modelo |

Formato estruturado das saídas (JSON validado com zod; se não validar, a tentativa conta como falha da tarefa, não como gate):

- `brief`: `{ objective, files: string[], contracts: string[], acceptance: string[], subtasks?: Subtask[] }`. Se `plan` devolver `subtasks`, elas só entram no banco depois que o coordenador aceitar, e nunca automaticamente pelo trabalhador.
- `diff`: `{ branch, commit, summary, checks: [{ cmd, exit, tail }] }`. O diff em si é o do branch (`base...HEAD`), com o commit gravado como snapshot.
- `findings`: `{ verdict: "approve" | "changes_requested" | "inconclusive", snapshot: commit, items: [{ file, line?, severity: "blocker" | "major" | "minor", impact, evidence }] }`. Só `blocker` e `major` exigem ação; preferência de estilo não conta como achado.

### 3. Seleção de modelo por papel

Fontes: esta tabela (papel → fase/categoria/esforço) e `config/router.yaml` (`models`, `tiers`, `phases`, `enabled`). Ordem de aplicação:

1. Candidatos = modelos da categoria capaz do papel (`tiers[tier]`).
2. Ficam só os fornecedores `claude-code` e `codex`. `grok-build` está fora (já comentado no YAML; o contrato também o exclui por adaptador, para que reativar o YAML sem querer não o coloque de volta). `enabled: false` (Terra) sai.
3. Saem os indisponíveis ou sem cota (`availability`, `markExhausted`), e também os modelos de `tried` no mesmo degrau, como hoje.
4. **Mais barato capaz:** ordenar por `price.input + price.output` (o mesmo critério para todos, que dispensa estimar tokens). Em caso de empate, vale a ordem de `phases[fase].prefer` e depois a de `tiers`.
5. Escalada: só depois da regra de reparo (§5), seguindo `escalation.ladder` da categoria inicial.

Resultado com os preços atuais: cheap fica Haiku = Luna (empate, decidido por `prefer`), mid fica Sonnet = Sol (empate, decidido por `prefer`, ou seja Sol em `implement`) e strong fica **Opus (24) antes de Astra (60)**. Isso inverte o `prefer` atual de `integration` e `full_review` (Astra primeiro). É uma mudança de comportamento e precisa de aprovação explícita (pendência A).

### 4. Revisão cruzada entre fornecedores (só com risco)

`risk = high` quando pelo menos uma destas condições vale:

- o papel é `integrate`, ou é `implement` derivado de `root_cause`;
- `files` inclui schema/migration (`src/store/db.ts`), lockfile, `config/*.yaml`, código de publicação/merge (`src/git/`, `src/verify/`) ou tratamento de segredos/canais;
- o diff final passa de `repair.simple.max_diff_lines` (100) ou altera uma assinatura exportada usada por outra subtarefa do plano;
- o planner justificou o risco em `risk_reasons`.

Regras:

- `risk = low`: sem revisão por modelo. O gate (local/CI) é a única verificação. Isso cobre `trivial_edit` e a maioria dos `implement`.
- `risk = high`: o `storeItems` insere logo após a subtarefa uma subtarefa `review` com `review_of`, `depends_on: [seq]` e `output: findings`.
- **Fornecedor diferente:** na hora de agendar, o revisor é escolhido pela §3 com um filtro extra: `adapter` diferente do adaptador da última tentativa que passou no gate da subtarefa revisada. Ordem de preferência: par do outro fornecedor, outro modelo mid de outro fornecedor, e por último outro modelo mid do mesmo fornecedor. Neste último caso a revisão deixa de ser cruzada: o attempt `review` recebe `ci_result` com sufixo `:same_provider_review` e o `reason` registra o autor. Sem nenhum revisor disponível o passo fica em `awaiting_review`; a retomada chama só a revisão sobre o commit gravado, sem repetir o agente.
- **Sem merge antes da revisão:** a subtarefa de risco, depois de passar no gate, termina em `awaiting_review` (branch e commit gravados, sem merge e sem PR para release), do mesmo jeito que `pr_open` já faz no modo staged. Os dependentes dela esperam o merge; `awaiting_review` não satisfaz `depends_on`.
- O revisor recebe o snapshot (commit), o brief, o `acceptance` e a saída dos checks; não executa testes nem edita.
- `approve`: segue para o fluxo normal de merge/publicação da subtarefa revisada.
- `changes_requested`: um reparo pontual (§5) no mesmo branch, com os achados `blocker`/`major` como diagnóstico. Depois vem o gate e uma nova revisão pelo mesmo modelo revisor. Uma segunda rejeição ou `inconclusive` deixa a subtarefa `failed` com os achados para o coordenador. Não há terceira rodada.

### 5. Reparo pontual antes de escalar

Mantém e generaliza o que `runStep` + `repairFor` já fazem:

1. **Falha de gate** (`verdict.gate`) ou **achado de revisão**: primeiro um reparo pontual no mesmo worktree/branch. O prompt leva só o diagnóstico (últimas 60 linhas ou os achados) e o diff atual, com a instrução de não refazer nem ampliar o escopo. A classificação simples/complexa segue `repair.simple`: o simples vai para cheap (low, depois medium); o complexo fica na categoria original.
2. Teto: `repair.max` (1) por falha; o reparo consome `escalation.max_attempts`.
3. Se o reparo falhar, ou se a falha não for reparável (timeout, erro do agente, parser), aplica-se o comportamento atual: tentar outro modelo do mesmo degrau e só então subir na escada.
4. "Agent made no changes" não escala (implementado). O gate local verifica se a base, ou os commits de tentativas anteriores, já atendem. Se passar, o passo fica `done` com "already satisfied". Se não passar, há uma única nova tentativa com o mesmo modelo/esforço, com o que falta no prompt, e depois `failed`. O caso real foi o passo 4 deste plano: Sol commitou o trabalho antes de esgotar a cota, e Sonnet não tinha mais o que mudar em medium/high/xhigh.
5. Cota esgotada não é falha: marca o modelo e tenta o próximo da mesma categoria, sem gastar tentativa.
6. Timeout não é sinal de modelo ruim. Consumo desconhecido continua `null`, nunca vira zero.

### 6. Registro no banco compartilhado e exposição em `status`

O banco é o mesmo arquivo (`defaultDbPath`, WAL) para servidor MCP e hooks. A migração é aditiva, no padrão de `openDb`:

- `steps`: `role TEXT`, `acceptance TEXT` (JSON), `output_kind TEXT`, `risk TEXT`, `risk_reasons TEXT` (JSON), `review_of TEXT` (id do step), `result TEXT` (JSON da saída estruturada validada) e um novo status `awaiting_review`.
- `attempts`: `kind` ganha o valor `review`, além de `task|repair`; `reason` registra o motivo da escolha ("mais barato capaz: opus-5-5 24 < gpt-6-astra 60", "revisão cruzada: autor codex"). O fornecedor é o `adapter`, que já existe.
- `tasks`: status `awaiting_review` quando sobrar apenas revisão pendente.
- `status({task_id})` passa a retornar, por step, `role, risk, risk_reasons, acceptance, output_kind, review_of, result` e as tentativas com `kind`/`reason`. Assim o coordenador (Claude ou Codex) consegue ver quem fez, quem revisou, o veredito e o custo sem ler o branch. Briefs, diagnósticos e achados seguem as mesmas regras de exposição já testadas em `run-plan.test.ts` e `repo.test.ts` (sem vazar dados de outra task).

### 7. Pendências para aprovação

- **A.** Aceitar a inversão para Opus antes de Astra em `integrate`/`full_review`/`root_cause` por causa do custo (§3).
- **B.** Aceitar `awaiting_review` como novo estado de step/task, sem merge até a revisão aprovar (§4).
- **C.** Aceitar a lista objetiva de gatilhos de risco (§4); ela pode ser movida para `router.yaml` (`cooperation.risk`) na implementação.
- **D.** Na implementação, adicionar ao `router.yaml` a fase `root_cause` e um bloco `roles` com o mapeamento da §1. Hoje isso fica só neste documento.

## Responsabilidade por tarefa

> Histórico. Depois que o contrato v1 for aprovado, a seleção segue a §3 do contrato acima e as linhas de Grok e Terra ficam desativadas.

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

`runPlan` já agenda passos independentes por promessas e respeita `depends_on`; `startBranch` cria worktree por passo a partir de `origin/<base>`. A concorrência por plano é limitada por `verify.max_parallel` (entre planos não há limite global), e `fileDependencies` serializa passos que declaram o mesmo arquivo. Não há competição com escolha de vencedor. Passos dependentes esperam o anterior terminar, incluindo seu fluxo de merge. Paralelismo seguro exige briefs e dependências corretos; worktree sozinho não resolve conflitos semânticos.

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

