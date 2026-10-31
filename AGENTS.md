# Repository Guidelines

## Estrutura e arquitetura

Servidor MCP em TypeScript para rotear tarefas entre Claude Code, Grok Build e Codex. `src/server.ts` expõe ferramentas; `triage/`, `planner/`, `policy/` e `runner/` coordenam trabalho. `adapters/` traduz CLIs; `store/` persiste SQLite. `hooks/` recebe mensagens e `.github/workflows/` contém CI. Consulte `ARQUITETURA.md` e `docs/model-policy.md` antes de alterar roteamento.

## Desenvolvimento e testes

Use Node.js >=24 e `npm ci`. Execute `npm test` e `npm run typecheck` antes de concluir alterações. `npm start` inicia o MCP por stdio e testa disponibilidade, consumindo tokens reais; não o use como teste unitário. Testes ficam junto ao código, nomeados `*.test.ts`, usando `node:test` e `node:assert/strict`; fixtures ficam em `test/fixtures/`.

## Convenções de código

Use ESM, imports com extensão `.ts`, indentação de dois espaços e TypeScript estrito. Preserve a separação entre transporte, política e execução. Registre adaptadores em `src/adapters/registry.ts`, compartilhado pelo servidor, CLI e benchmark. Use `Exec` injetável e `fakeExec` nos testes; não invoque modelos pagos em verificações automáticas.

## Diretrizes para Codex e Claude

- Escreva o plano antes de implementar e siga Red → Green → Refactor.
- Mantenha modelo e esforço explícitos por tentativa e respeite a categoria configurada.
- Use `phases.<fase>.prefer` para dividir responsabilidades: Opus planeja, Sol implementa, Astra integra/revisa. O fallback permanece na mesma categoria; preferências ainda exigem avaliação local.
- Codex: Luna para tarefas triviais; Sol para implementação planejada; Astra para problemas complexos. Terra é especializado e fica desativado até avaliação. Essas escolhas são hipóteses iniciais, não resultados de benchmark local.
- Preserve o sandbox. Não use flags que removem aprovações e isolamento. Codex ignora configuração global do CLI para evitar MCP recursivo, mantendo instruções do projeto.
- Não confunda estimativa de tokens com fatura ou saldo da assinatura. Registre fonte e data dos preços; não invente tokens ou cobrança ausentes.
- `Exec` é buffered e usa arquivos privados temporários para evitar perda de stdio em sockets restritos. Preserve limpeza e códigos de erro. O launcher MCP Python usa pipes reais; valide handshake, não apenas `tools/list` em memória. Use `ROUTER_CHECK_MODELS=manual` em testes sem modelos pagos.

## Commits e revisão

Siga o histórico: `feat:`, `fix:`, `docs:` e `ci:`, com escopo quando útil. Descreva comportamento, testes e limitações no PR. Não publique segredos. Preserve documentos históricos em `.planning/`; documente extensões atuais em `docs/`. Não anuncie modo nuvem ou execução real sem comprovação correspondente.
