# Execução e integração Claude/Codex — 2026-10-30

Pedido: corrigir exec, pesquisar modelos, dividir responsabilidades e conectar MCP ao Claude Code.

## Diagnóstico e contrato

- `spawn` do Node fornece stdio por socketpair; sob este sandbox, `guessHandleType` devolve tipo desconhecido no filho e Node cria um Writable que descarta dados. `fs.writeSync(1)` funciona; `process.stdout.write` desaparece. Python com pipes convencionais funciona. Não remover o sandbox.
- Usar diretório temporário privado e descritores de arquivos para stdin/stdout/stderr. Ler resultados ao fechar o subprocesso e remover recursos em sucesso, erro e timeout. Preservar contrato Exec, cwd e códigos 127/124.
- Cobrir captura UTF-8, stdin, argumentos literais, ausência de binário e timeout com testes reais sem modelos.
- Conferir preços e esforço em fontes oficiais Claude/OpenAI. Preferências por fase devem ser validadas e usadas tanto em route quanto em execução; categorias/fallback continuam respeitados.
- Conectar o MCP existente no Claude usando caminhos absolutos e testar handshake e tools/list. Testes de modelos reais serão leituras curtas, sem alterações de projeto ou publicação.

## Etapas

1. RED nos testes de exec e stdin; corrigir stdio e verificar suíte completa.
2. RED na seleção por fase; implementar preferências e atualizar preços Claude com proveniência.
3. Documentar responsabilidades, limitações e protocolo de brief/resultado entre agentes.
4. Validar MCP via transporte real, reparar registro Claude se necessário e testar acesso de leitura aos agentes.
5. Revisão independente, testes finais e relatório do que foi efetivamente comprovado.

## Resultado

- Exec corrigido com regressão Red → Green e captura real UTF-8/stdin/erros/timeout.
- Preferências por fase implementadas e preços Claude atualizados em fontes oficiais. A implementação mid de planos strong seleciona Sol.
- MCP validado por cliente SDK real; entrada bloqueante e não bloqueante cobertas. Revisão identificou risco de encerramento; teste com worker que ignora SIGTERM falhou antes e passou após timer independente com SIGKILL em cinco segundos. Reavaliação: ACCEPT.
- `npm test`: 27 arquivos passaram; `npm run typecheck` e `git diff --check` passaram.
- Registro Claude preparado via Python launcher. Claude fecha stdio antes do handshake; o sandbox nega socket local com EPERM e consultas externas falham DNS. Testes reais Haiku/Luna não completaram, sem tokens reportados. Não afirmar conexão efetiva ou inferência validada.
- Um commit paralelo `a7d0307` acrescentou cache-write opcional ao parser Codex e incluiu catálogo; alterações preservadas. Nenhum commit, push ou publicação foi feito por esta execução.
