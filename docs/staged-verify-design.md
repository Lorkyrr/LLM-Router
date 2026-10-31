# Verificação em dois estágios (implementado)

Implementado em `verify.mode: staged` (`src/runner/run-step.ts`, `src/verify/local.ts`). Decisões em aberto resolvidas com as sugestões: o gate local roda só teste e typecheck (kind fica no estágio 2), uma falha do CI reroda o gate local antes do novo push, e há um só teto de tentativas (`max_attempts`). A chave de configuração é `verify.local.cmds`; `ROUTER_LOCAL_TEST` aceita comandos separados por `&&` e `ROUTER_VERIFY_MODE=staged` escolhe o modo.

Objetivo: o código do agente só chega ao GitHub depois de passar num CI local; só então roda o workflow de auto-merge do repositório. Falha barata (local) nunca gasta PR, runner nem fila de CI.

## Fluxo de um passo

```
agente edita o worktree
        │
   ┌────▼─────────────── Estágio 1: gate local (máquina do usuário) ──────────────┐
   │ commit no branch router/step-*                                                │
   │ rebase no base local/remoto                                                   │
   │ roda verify.local.cmds em sequência, no worktree (teste, typecheck, smoke)    │
   └────┬───────────────────────────────┬──────────────────────────────────────────┘
      verde                           vermelho / conflito
        │                               └─► motivo (cauda da saída) volta ao agente: sobe a escada de esforço
   ┌────▼─────────────── Estágio 2: promoção (GitHub) ─────────────────────────────┐
   │ push do branch + gh pr create (publishBranch, já existe)                      │
   │ workflow router-verify roda no runner self-hosted (lease só aqui)             │
   │ verifyAndMerge: checks verdes → gh pr merge --rebase (já existe)              │
   └────┬───────────────────────────────┬──────────────────────────────────────────┘
      merged                          vermelho no CI / conflito
        │                               └─► motivo volta ao agente, mesmo branch e mesmo PR
   limpa worktree + branch
```

Os dois estágios compartilham a mesma escada de tentativas (`escalation.ladder`, `max_attempts`). Uma tentativa vermelha em qualquer estágio sobe o esforço; a falha do estágio 2 reentra no estágio 1 antes de dar novo push.

## O que muda em relação ao modo `local` atual

O modo `local` de hoje faz fast-forward no checkout do usuário e encerra ali. No modo `staged` o checkout do usuário **não é tocado**: o worktree isolado é "a máquina" onde o código é aplicado e testado, e o merge final acontece no GitHub. Isso elimina as restrições do `local` (checkout no branch base, arquivos sujos) e mantém o histórico do remoto como fonte da verdade.

## Configuração proposta

```yaml
verify:
  mode: staged          # pr | local | staged
  local:
    cmds:               # todos precisam sair 0, em ordem; o primeiro que falhar encerra o estágio
      - [npm, run, typecheck]
      - [npm, test]
    timeout_s: 1800
  auto_merge: true      # vale no estágio 2; false deixa o PR aberto após CI verde
  delete_branch: true
```

`ROUTER_LOCAL_TEST` continua valendo como atalho do modo `local` e passa a preencher `verify.local.cmds` com um comando só quando `mode: staged`.

## Mudanças de código (pequenas, tudo reutiliza o que existe)

| Onde | Mudança |
|---|---|
| `src/config.ts` | `mode: "staged"`; `verify.local.cmds` (lista de argv), obrigatório em `local` e `staged`. |
| `src/verify/local.ts` | Extrair `runLocalChecks(exec, {worktree, cmds, timeoutMs})` do início de `verifyLocal`; ele devolve `passed` ou `failed` com a cauda da saída. O merge fast-forward continua só no modo `local`. |
| `src/runner/run-step.ts` | Ramo `staged`: `commitAll` → rebase → `runLocalChecks` → se verde, cair no caminho `pr` existente (`publishBranch` + `verifyAndMerge`). Vermelho local faz `rung++` sem push. |
| `src/runner/run-step.ts` | `lease.acquire()` só em volta do estágio 2, como já é hoje. |
| `src/store` | Sem migração: `attempts.ci_result` é TEXT. Novos valores: `local_failed`, `local_conflict`, além de `merged`/`failed`/`conflict`. |
| `status` | Mostrar em qual estágio cada tentativa parou. |

## Casos de borda

- **Rebase antes do estágio 1:** testa o código já sobre o base atual, então o resultado local se parece com o do CI. Conflito vira `local_conflict`, sem push.
- **Falha só no CI (ambiente diferente):** o motivo (tabela de checks + cauda do log, já implementado) volta ao agente; se o local passou e o CI não, vale registrar isso na tentativa como sinal de que `verify.local.cmds` está mais fraco que o workflow.
- **Cota esgotada:** igual ao fluxo atual, não conta como tentativa vermelha.
- **Sem GitHub/`gh`:** `staged` exige remoto e autenticação. Sem eles, use `mode: local`.
- **`auto_merge: false`:** para após CI verde com o PR aberto; é a primeira vez que a opção passa a ter efeito no caminho de PR.

## Testes (Red → Green)

1. `runLocalChecks`: ordem das cmds, primeiro vermelho encerra, cauda da saída no motivo, timeout.
2. `run-step` em `staged`: local vermelho não faz push nem chama `gh`; local verde chama `publishBranch` e `verifyAndMerge` nessa ordem; CI vermelho volta ao estágio 1 na tentativa seguinte; lease só no estágio 2.
3. Config: `staged` sem `verify.local.cmds` é rejeitado.
4. Integração com git real e remoto bare temporário, agente e `gh` falsos (mesmo padrão de `run-step.local.test.ts`).

## Decisões (resolvidas)

- `verify.local.cmds` deve incluir o `kind-up.sh` (cluster) ou o estágio 1 fica só em teste e typecheck? Sugestão: só teste e typecheck; o kind já roda no estágio 2.
- Rerodar o estágio 1 depois de uma falha só do CI, ou ir direto a novo push? Sugestão: rerodar, é barato.
- Limite de tentativas por estágio ou um só teto? Sugestão: um só (`max_attempts`).
