# Política de modelos e custos

Para divisão de responsabilidades, coordenação, paralelismo e limites comprovados da avaliação de 2026-10-31, veja [Cooperação entre agentes](agent-cooperation.md). As preferências abaixo continuam sendo hipóteses até benchmark local.

Consulta em **2026-10-30**, USD por milhão de tokens, API Standard. OpenAI: contexto até 272 mil tokens, escrita de cache de 30 minutos. Claude: escrita de cache de 5 minutos; Haiku tem preço-base até 100 mil tokens de prompt. A fonte executável é `config/router.yaml`; `guidance` registra recomendações expostas por `route`, e `pricing` preserva fonte/data.

| Modelo | Entrada | Cache lido | Cache escrito | Saída | Diretriz inicial |
|---|---:|---:|---:|---:|---|
| GPT-6 Luna | 0,10 | 0,01 | 0,125 | 0,50 | Triagem e edição trivial, low |
| GPT-6.1 Sol | 2,00 | 0,10 | 2,50 | 10,00 | Implementação/testes, medium |
| GPT-6.1 Terra | 1,00 | 0,05 | 1,25 | 5,00 | Visão, interface e escrita; desativado |
| GPT-6 Astra | 10,00 | 1,00 | 12,50 | 50,00 | Arquitetura e investigação complexas, high |
| Claude Haiku 5.5 | 0,10 | 0,01 | 0,125 | 0,50 | Classificação simples, low |
| Claude Sonnet 5.5 | 2,00 | 0,10 | 2,50 | 10,00 | Implementação especificada, medium |
| Claude Opus 5.5 | 4,00 | 0,20 | 5,00 | 20,00 | Planejamento complexo, high no router |

Fontes oficiais: [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).

Claude: [preços](https://platform.claude.com/docs/en/about-claude/pricing), [Haiku](https://platform.claude.com/docs/en/models/haiku-5-5/overview) e [esforço](https://platform.claude.com/docs/en/build-with-claude/effort). A referência antiga do projeto (Haiku 1/5, Sonnet 3/15 e Opus 5/25) foi substituída pelos valores oficiais atuais acima. Haiku cobra 5× essas taxas quando o prompt ultrapassa 100 mil tokens. Sonnet/Opus atuais mantêm preço Standard na janela completa; não aplicar a eles a regra de contexto longo OpenAI.

## Seleção e esforço

### Mensagens com várias tarefas

`route` tenta decompor listas numeradas, marcadores, linhas e conectores em português
antes da triagem da mensagem inteira. `e também`, `e` seguido de um comando e
`enquanto isso` separam itens independentes; `depois`/`em seguida` criam uma barreira
que aguarda todos os itens anteriores. Arquivos explicitamente compartilhados também
criam dependências. A numeração, sozinha, não torna a lista sequencial.

A heurística reconhece comandos e fases conservadoramente. Contexto comum, código
em blocos, referências como “essa arquitetura” e comandos desconhecidos usam um
modelo disponível da categoria **cheap**, sempre em **low**, read-only. A preferência
de triage só é usada se também for cheap. Não existe fallback strong para decompor:
sem cheap disponível, `plan` fica em `waiting_quota`. Respostas inválidas têm duas
tentativas; dependências próprias, futuras ou não positivas são rejeitadas antes de
gravar passos. O planner também usa cheap/low para pedidos únicos que exigem divisão.

Cada item usa `phases.<fase>.tier`, `effort` e `prefer`, com fallback da mesma categoria.
As preferências e a ordem dos tiers representam a política de custo/adequação;
não há nova ordenação por preço. Edição trivial fica em cheap/low, implementação e
testes em mid/medium; só itens classificados como planejamento, integração ou revisão
complexos recebem strong. Um `override_tier` explícito continua prevalecendo por item.

Exemplo: “Renomeie o título em README.md e também planeje a arquitetura; enquanto
isso, implemente testes de cache; depois, implemente a API” produz quatro itens:
Haiku low, Opus high, Sol medium e Sol medium. Os três primeiros são independentes;
o quarto aguarda os três. Grok permanece desativado.

`route.subtasks` e `plan.steps` expõem brief, fase, tier, effort, modelo, motivo,
arquivos e dependências por número. Para mensagens decompostas, `route` já grava os
passos e retorna `next: run` (ou `wait` se algum modelo estiver indisponível); não
chame `plan` novamente sobre esses passos. Pedidos únicos preservam o resumo legado
e incluem `subtasks`; strong único ainda retorna `next: plan`.

O runner grava fase/esforço/motivo em cada passo e aplica fase e esforço na primeira
posição da escada, inclusive no fallback de modelo; depois mantém a escalada existente.
Passos antigos com esses campos nulos continuam usando a política legada da tarefa.
A migração SQLite adiciona colunas sem apagar histórico.

`verify.max_parallel` é inteiro positivo, padrão **2**, e limita passos simultâneos
por chamada de `run_plan`. Dependências aguardam fora das vagas; falhas liberam vagas
e bloqueiam somente os dependentes. Ciclos/ids inválidos continuam bloqueados. Cada
passo usa seu worktree; o limite não coordena outras chamadas/processos. A heurística
não é um parser geral de linguagem natural: modelos baratos ainda podem errar a
interpretação, e arquivos omitidos não permitem detectar conflitos antecipadamente.

`phases.<fase>.prefer` define a preferência específica; `tiers` continua como fallback. As referências precisam pertencer à categoria da fase. Modelos indisponíveis ou `enabled: false` são pulados; modelos desativados não são pingados. Não há ordenação automática por preço.

| Fase | Preferência | Alternativa | Responsabilidade |
|---|---|---|---|
| Triagem | Haiku low | Luna low | Identificar fase e categoria, sem implementar |
| Planejamento | Opus high | Astra high | Critérios de aceite, dependências, arquivos e briefs |
| Implementação | Sol medium | Sonnet medium | Executar o brief, escrever testes e corrigir falhas |
| Integração | Astra high | Opus high | Analisar contratos e efeitos entre partes |
| Revisão completa | Astra high | Opus high | Procurar regressões e inconsistências |

O runner aplica a preferência de implementação aos passos mid de um plano strong; a escolha de `route` não fica desconectada da execução. Fallback de triagem segue a lista cheap. As preferências são decisões iniciais do projeto, não evidência de superioridade entre fornecedores. Haiku/Luna e Sonnet/Sol têm preços-base equivalentes; qualidade e tokens realmente usados precisam de avaliação local. Terra continua desativado até avaliação especializada. [Critérios OpenAI](https://developers.openai.com/api/docs/guides/model-selection) e [critérios Claude](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model).

Isso configura seleção por fase, não cria um ciclo automático obrigatório de autor → revisor. O executor Git ainda exige mudanças; revisões sem alterações devem ser feitas como consultas de leitura fora de `run_plan` até existir um fluxo próprio.

Comece em low para classificação e mudanças isoladas; medium para implementação planejada; high para investigação complexa. Aumente esforço mediante evidência de dificuldade. A escada existente é cheap low → mid medium → mid high; mid medium → high → xhigh; strong high → xhigh. Não há troca automática de mid para strong nessa escada. Esforço não é multiplicador fixo de preço: altera tokens e latência. Benchmarks locais devem medir sucesso, tempo e gasto total, incluindo tentativas, antes de mudar preferências.

## Contabilização

`(entrada × preço + saída × preço + cache_lido × preço + cache_escrito × preço) / 1.000.000` calcula a referência. Exemplo: 10 mil tokens de entrada sem cache e 2 mil de saída em Sol representam US$ 0,04 Standard.

Codex inclui cache lido em `input_tokens`: o adaptador subtrai essa parcela para persistir categorias exclusivas. `output_tokens` é preservado sem somar novamente raciocínio. O parser também aceita `cache_write_input_tokens` opcional e o trata como subconjunto da entrada; esse formato precisa ser confirmado com uma execução real da versão instalada. Se ausente, escrita desconhecida fica em zero. `cost_usd` retorna `null` e o runner estima pelo catálogo; a falta de dados pode subestimar custo.

Para os modelos OpenAI cadastrados, acima de 272 mil tokens as taxas são 2× entrada/cache e 1,5× saída; Fast e outras modalidades também mudam preços. O estimador não reconstrói ajustes por chamada, incluindo a faixa longa do Haiku, portanto não serve como orçamento rígido. Valores dos outros CLIs também não são reconciliação de fatura.

`status.cost.recorded_or_estimated_usd` soma valores registrados e estimados das tentativas; `billing_verified` é `false`. `actual_usd` é alias legado, sem confirmação financeira. Triagem, planejamento e pings ainda não entram na soma. A linha de base “tudo no forte” reprecifica os mesmos tokens; não comprova economia real nem igualdade de qualidade.

Assinatura tem limites e contabilização próprios; equivalência API não mede saldo, créditos ou cobrança incremental. Veja [preços do Codex](https://learn.chatgpt.com/docs/pricing).

## Execução Codex

O adaptador usa `codex exec --json --ephemeral --ignore-user-config`, `approval_policy="never"` e sandbox `workspace-write`; classificação, planejamento e ping usam `read-only`. `never` impede espera por aprovação interativa e não remove o sandbox. Configuração global de modelo, MCP e plugins não é herdada; autenticação salva e instruções `AGENTS.md` permanecem aplicáveis. Pings fora de Git usam `--skip-git-repo-check` e limite de 60 segundos. Modelos sem acesso serão marcados indisponíveis.

O fluxo exige `turn.completed` para considerar sucesso e preserva falhas/cota do JSONL. Veja [execução não interativa](https://learn.chatgpt.com/docs/non-interactive-mode). Autentique localmente com `codex login`; não copie credenciais para o repositório. As tentativas reais de leitura em 2026-10-30 não obtiveram resposta neste sandbox; não há comparação empírica de qualidade registrada.

## Handoff entre agentes

O planejador entrega objetivo, critérios de aceite, arquivos e dependências em um brief autossuficiente; não repassa o histórico inteiro. O implementador recebe o mesmo brief e a falha anterior em nova tentativa. Registre modelo/esforço/resultado no banco. Uma revisão deve receber diff, requisitos e saída dos testes; nenhuma declaração de conclusão do agente substitui checks. Não encaminhe credenciais ou autorizações implícitas entre sessões. Cada CLI mantém suas próprias permissões e instruções.

Claude suporta low/medium/high/xhigh/max nos modelos atuais; o router usa até xhigh. Sonnet recomenda medium para implementação bem especificada, apesar do default API high; Opus e Haiku têm default medium. Não transportar configurações ou resultados de benchmark de uma versão antiga sem reavaliar. Fable 5.1 é opção oficial para trabalho de horizonte longo, mas não foi habilitado no catálogo sem avaliação e acesso confirmados.
