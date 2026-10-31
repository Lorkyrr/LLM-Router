# Validação manual

## Sem chamadas pagas

Execute `npm test`, `npm run typecheck`, `codex --version` e `codex exec --help`. Os testes Codex simulam subprocessos e cobrem JSONL, cache, erros, cota, sandbox e integração com triagem; não confirmam acesso aos modelos da conta.

## Smoke real

Este procedimento consome cota e pode publicar alterações. Use repositório de teste autorizado, banco exclusivo (`ROUTER_DB`) e runner de CI configurado. O fluxo atual tenta merge após checks verdes; `verify.auto_merge` ainda não desliga essa chamada.

1. Autentique os CLIs usados e `gh` localmente.
2. Inicie MCP com `ROUTER_REPO_DIR` apontando para o projeto de teste. Confirme disponibilidade em `check_models`.
3. Para testar Codex, use uma cópia do catálogo com seus modelos primeiro em `tiers` e triagem Luna; selecione-a com `ROUTER_CONFIG`.
4. Envie edição pequena por `route`, execute `run_plan` e acompanhe `status`.
5. Confira branch/worktree, modelo/esforço, PR, checks e resultado. Trate custo como referência, não fatura.

## Resultado observado em 2026-10-30

- Testes reais de `exec`: stdout, stderr, UTF-8, stdin, argumentos literais, erro 127 e timeout 124 passaram.
- Handshake initialize, tools/list e chamada status passaram via SDK MCP e processo real, fora da pasta do projeto, com stdin bloqueante e não bloqueante.
- Claude Code 2.1.314 e Codex CLI 0.166.0 estão instalados e informam autenticação por assinatura. Nenhuma credencial foi copiada para o projeto.
- Registro `llm-router` atualizado em `~/.claude.json` para Python launcher e pings manuais; demais servidores preservados.
- `claude mcp get llm-router` ainda retorna conexão fechada neste sandbox. O launcher registra EOF de stdin antes de receber qualquer mensagem. Mesmo forçando o runtime legado documentado, o resultado persiste. Criação de socket local retorna `EPERM`; os logs Claude mostram `EAI_AGAIN` na consulta externa.
- Tentativas de leitura simples com Haiku e Luna não produziram resposta: timeout de 60 segundos e stream sem conclusão, respectivamente; zero tokens reportados. Não é evidência de indisponibilidade geral desses modelos fora deste ambiente.
- Nenhum PR, push, merge ou workflow foi disparado. Cloud continua incompleto. A seleção por fase está testada; um ciclo completo de implementação/revisão com modelos reais não foi validado.

Para concluir a verificação no terminal normal: `claude mcp get llm-router`, abra `/mcp` em uma nova sessão e execute `check_models` conscientemente (consome cota). Use banco por projeto. Não interprete apenas autenticação ou presença no catálogo como prova de acesso ao modelo.
