# Plano: Codex e política de modelos

Escopo aprovado em 2026-10-30: incluir Codex como executor, preços e diretrizes OpenAI, instruções aos contribuidores e documentação geral.

## Contrato

- Reutilizar `Adapter`, `Exec`, seleção por categoria e tentativas existentes; sem dependências novas.
- Executar `codex exec --json --ephemeral` com modelo e esforço explícitos, sandbox `workspace-write`; pings e classificação em `read-only`.
- Normalizar JSONL: mensagem final, conclusão obrigatória, falhas, cota, tokens e cache sem contagem duplicada. Não inventar custo efetivo quando o CLI só informa tokens.
- Registrar Luna em cheap, Sol em mid e Astra em strong como alternativas aos agentes existentes. Terra permanece alternativa especializada, sem preferência automática para código.
- Preços USD/1M Standard com fonte e data; estimativas não representam fatura ou cota da assinatura. Contexto longo e cache não exposto limitam precisão.
- Preservar documentação histórica em `.planning/`; atualizar arquitetura e criar instruções locais em `AGENTS.md` (não há `AGENTES.md` neste repositório).

## Execução e verificação

1. Escrever testes do adaptador e configuração; observar falhas antes de implementar.
2. Implementar parser e adaptador; registrar em MCP, CLI e benchmark através de uma fábrica compartilhada.
3. Acrescentar preços, diretrizes e validações ao catálogo; testar seleção e contabilização normalizada.
4. Atualizar documentação e instruções, executar testes e typecheck, revisar diff.

## Pontos de revisão

JSON truncado não pode virar sucesso; cached input é subconjunto de input; falha sem mensagem final deve preservar motivo; ping fora de Git precisa de flag explícita; testes não podem chamar modelos pagos. O workflow cloud continua esqueleto e não será anunciado como funcional.

## Registro

- Implementação direta na branch `feature/codex-adapter-pricing`, sem push, merge ou chamadas pagas.
- Falha anterior conhecida: `src/exec.test.ts` no ambiente atual; verificar separadamente ao concluir.
- Adaptador, registro compartilhado, catálogo, seleção de modelos habilitados e metadados MCP implementados com testes Red → Green.
- Documentação criada/atualizada: README, arquitetura, política, smoke e AGENTS local; AGENTS global recebeu apenas seção adicional do projeto.
- `npm run typecheck` passou. `npm test`: 25 arquivos passam, 1 falha preexistente (`src/exec.test.ts`). Captura vazia de stdout de subprocessos Node também reproduzida fora dos testes; `printf` preserva stdout. Causa ainda não estabelecida, sem alteração no executor compartilhado.
- Sem chamadas pagas, push, merge ou execução de workflow. Revisão independente: ACCEPT, sem achados bloqueantes. Testes focados: 36 passaram; `git diff --check` passou.

Continuação posterior: a falha de exec foi corrigida e toda a suíte passou. A política passou a usar preferência por fase e houve tentativas reais de leitura sem resposta neste sandbox. O estado atualizado está em [exec-integration-plan.md](exec-integration-plan.md).
