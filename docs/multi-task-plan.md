# Decomposição de mensagens: plano de implementação

Escopo: separar pedidos em português antes de escolher modelos, preservar dependências
e executar itens independentes com concorrência limitada. Sem dependências novas,
sem chamadas pagas nos testes e sem habilitar Grok.

1. Red: exemplos com listas, conectores, ambiguidade e dependências inválidas;
   testes MCP e de concorrência. Confirmar falhas antes de implementar.
2. Green: heurística conservadora compartilhada por route/plan; fallback apenas
   cheap/low, com JSON validado e dependências anteriores. Classificar cada item
   pelas phases; manter tiers/prefer como política de escolha. Arquivos coincidentes
   também criam dependências.
3. Persistir fase/esforço/motivo opcionais por passo, com migração aditiva SQLite
   e compatibilidade com passos antigos. Aplicar estes valores na primeira tentativa.
4. Limitar runPlan por verify.max_parallel (inteiro positivo, padrão 2), adquirindo
   vaga somente depois das dependências. Liberar vagas inclusive em falhas.
5. Expor subtarefas com fase, tier, esforço, modelo, dependências e motivo; documentar
   limites da heurística, rodar npm test/typecheck, revisar diff, commit e push sem merge.

Arquivos: src/triage/decompose.ts e testes; planner e testes; server e testes;
config e testes/YAML; store/db.ts e repo.ts; runner/run-step.ts e run-plan.ts e testes;
docs/model-policy.md e ARQUITETURA.md.

Riscos a verificar: conjunções dentro de um único objeto; contexto comum em listas;
cota indisponível sem escalada strong; barreiras sequenciais; fase de passos antigos;
retomada e liberação de vagas; upgrade de banco sem perda de dados.

Execução: implementado com ciclos red/green para decomposição, concorrência, MCP,
pontuação, numeração inline, classificação pelo comando e referências de dependência.
Revisão independente encontrou os casos de pontuação, palavra “planejamento” no
objeto da edição e referências ao plano; corrigidos com regressões red/green.
Configuração, migração legada e aplicação de fase/esforço também têm verificações
locais. Nenhuma chamada a modelo pago foi usada.
