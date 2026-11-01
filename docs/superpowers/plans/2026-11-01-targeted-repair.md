# Reparo pontual antes da escalada

Requisitos: manter o worktree e a escada atuais; após falha de gate, tentar correção com apenas diagnóstico e diff, sem repetir o brief. Sem mudanças, falha do agente, conflito ou falha de merge seguem a escada sem reparo.

1. Red: adicionar testes com fakeExec para cheap/low em falha simples, mesmo tier/esforço em falha complexa, repetição em medium, limite global, quota, no-changes e retorno à escada; validar configuração e migração SQLite.
2. Green: adicionar `repair` com defaults (enabled, max=1, limiares de testes/diff e padrões regex validados); classificar deterministicamente em `src/policy/repair.ts` e reutilizar `selectModel`/disponibilidade.
3. Integrar em `run-step.ts`: reparar apenas gates identificados pelo verificador, obter diff do branch contra o base, limitar contexto à cauda do gate e diff, contar reparos em max_attempts. Reparos não avançam nem contaminam os modelos tentados na escada; quota mantém fallback da categoria do reparo. Após até max reparos por tentativa de tarefa, retornar à escada original.
4. Persistir `kind` (task|repair) e `reason` com migração aditiva/idempotente; defaults preservam inserções antigas. Exportação pública inclui apenas kind, sem diagnóstico livre.
5. Atualizar README/ARQUITETURA e testes afetados; rodar npm test e npm run typecheck, revisar, commit e push do branch atual, sem merge.

Escolhas: max_attempts permanece teto compartilhado de falhas (quota segue sem consumir esse teto, como antes); não adicionar budget paralelo. Se a categoria de reparo estiver indisponível, seguir a escada. Diff indisponível encerra com erro explícito, sem executar reparo com contexto incompleto. Diff grande impede classificação simples; diagnóstico desconhecido é complexo. Não adicionar dependências nem juiz LLM.

Foco da revisão: reparo barato não altera tier original; no-changes não inicia/repete reparo; max=0 e enabled=false preservam fluxo antigo; migração preserva linhas; conflitos/falhas de merge não são gates.
