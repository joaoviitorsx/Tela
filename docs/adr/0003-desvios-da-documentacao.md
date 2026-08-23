# ADR 0003 — Desvios da documentação técnica

**Status:** parcialmente obsoleta — ver notas por item · **Data:** 2026-08-23

> O changeset 001 (ADR 0005) removeu a camada de servidor HTTP, então os itens
> 2 e 6 deixaram de existir. O item 3 continua valendo e o item 5 também. O
> item 1 foi absorvido: a estrutura de camadas do AGENTS.md é agora a única.

Registro dos pontos em que a implementação não seguiu a documentação ao pé da
letra, com o motivo. AGENTS.md manda os documentos vencerem a intuição — então
cada item aqui é uma dívida explícita, não uma escolha silenciosa.

---

## 1. Estrutura de pastas: AGENTS.md vence a §7

A §7 da documentação técnica desenha `apps/api/src/{routes,services,lib}` e
`apps/web/src/{lib,store}`. O AGENTS.md, escrito depois, define
`domain/ports/application/infra/http` na API e `core/adapters/react/components/routes`
no web, e chama isso de regra inegociável (R1, R2, R3).

**Seguido:** AGENTS.md. A §7 é o esboço anterior; as sete regras são o contrato
atual, e violá-las invalida o trabalho mesmo com testes passando.

---

## 2. `POST /broadcast/*` recebe o slug no corpo

A §6 documenta `POST /broadcast/start { ownerToken }` sem slug, e a §8.2
implementa `verifyOwner(slug, ownerToken)` — que precisa do slug. Para fechar,
faltaria um índice reverso `ownerHash → slug` no Redis.

**OBSOLETO (ADR 0005):** não há mais API HTTP. O slug e o ownerToken viajam
na primeira mensagem do WebSocket de sinalização, no `host`.

**O que era:** `{ ownerToken, slug }` no corpo. O cliente sempre sabe o
próprio slug (está no `localStorage` ao lado do token), então mandá-lo é de
graça; um índice reverso seria uma segunda fonte de verdade capaz de divergir
da primeira.

Caminho e método continuam iguais aos documentados. O `ownerToken` segue apenas
no corpo, nunca em URL ou query string.

---

## 3. Slug mínimo de 3 caracteres — e `tela.gg/jv` não passa

A §5 declara "3 a 25 caracteres" e a regex `^[a-z0-9][a-z0-9-]{1,23}[a-z0-9]$`,
que também exige 3. Mas o exemplo usado na documentação inteira é `tela.gg/jv`
— e `jv` tem 2.

**Implementado:** a regra escrita (mínimo 3), porque ela aparece duas vezes de
forma precisa e o `jv` só aparece como ilustração.

**Isto merece decisão humana.** Se `jv` deve funcionar, a mudança é trocar
`{1,23}` por `{0,23}` em `packages/shared/src/schemas.ts` — **um lugar só**.

Correção desta ADR: a versão original dizia "em `domain/slug.ts` e no schema",
citando dois lugares. Havia **três** cópias da regex, e a terceira era um
literal inline na UI. Seguir a instrução ao pé da letra teria deixado o front
rejeitando um slug que a validação aceitava. Hoje `SLUG_RE` mora só em
`@tela/shared` e todo mundo importa de lá.

---

## 4. Terceiro preset de qualidade

A §8.3 define dois presets. Foi adicionado um terceiro, `720p60 econômico`
(~2,5 Mbps), a pedido de escolha de qualidade pelo usuário.

Nenhuma das três configurações travadas pela R5 mudou: `contentHint='motion'`,
`degradationPreference='maintain-framerate'` e `videoCodec='h264'` seguem
iguais, e o novo preset tem **duas** camadas como os outros. Ele também mantém
60fps: o degrau que cai é resolução e bitrate, nunca framerate.

O motivo é a ADR 0002 — em P2P o gargalo é o upstream doméstico, e 720p60 a
4 Mbps ainda é muito para três espectadores num link assimétrico.

---

## 5. Roteador próprio em vez de `react-router`

O produto tem quatro telas e nenhuma rota aninhada. `history.pushState` +
`popstate` resolvem em 40 linhas (`apps/web/src/router.ts`). AGENTS.md exige
justificar toda dependência nova; não havia justificativa.

---

## 6. Rate limit em memória

**OBSOLETO na forma original (ADR 0005):** não há mais API HTTP. O rate limit
vive agora em `apps/signaling/src/limits.ts`, e a limitação continua a mesma e
continua explícita: o contador é por processo. Com mais de uma instância, cada
uma conta separado. Não é defesa contra DDoS distribuído.

Um defeito encontrado por auditoria e já corrigido: a varredura só tinha teto
de tamanho, então acima de 10.000 baldes ela rodava O(n) em toda mensagem — e
com baldes vivos não liberava nada. Agora roda no máximo uma vez por minuto.
