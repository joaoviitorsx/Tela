# ADR 0025 — Aprovação manual de cada espectador

**Data:** 2026-09-28
**Estado:** aceita; deixou de ser obrigatória na ADR 0028 (sala aberta por padrão, aprovação como opção da sala)
**Mantém:** R6 (sem conta), R8 (payload opaco), ADR 0021 (convite)

## Contexto

O convite (ADR 0021) é um token compartilhado: quem tem o link entra, e o
link vai parar em lugares que o dono não controla — um print, um canal errado
do Discord. O dono pediu para aceitar cada pessoa antes de ela ver a tela.

## Decisões (as de produto são do dono, tomadas em 2026-09-28)

1. **Sempre obrigatória.** Não existe chave para desligar: toda entrada nova
   passa pelo dono.
2. **Apelido digitado.** O espectador diz como quer aparecer (1 a 24
   caracteres, sem caractere de controle). Fica no navegador dele
   (`tela.apelido`). Não é conta: ninguém confere, dois podem usar o mesmo.
3. **Quem foi aceito volta direto até o dono desconectar todos.** Cada navegador
   de espectador tem uma chave de 128 bits (`tela.espectador`). O servidor manda
   ao dono só o `sha256` dela — a *impressão* —, calculado no servidor: se o
   cliente mandasse a própria impressão, qualquer um se passaria por quem já foi
   aceito. O dono guarda as impressões aceitas (`tela.aprovados`, até 64) e
   aceita sozinho quem já conhece. **Desconectar todos zera a lista.** (Havia
   também "renovar o convite", que saiu com o convite na ADR 0026.)
4. **Aviso ao dono:** fila no console com ACEITAR / RECUSAR, contador no título
   da aba (`(2) ● No ar · Tela`) e um bipe curto por pedido novo (respeita o
   mudo). A placa de repouso — o que vai na captura se a aba ficar visível —
   mostra só a contagem, nunca os nomes.
5. **Recusa não é bloqueio.** O espectador recebe `DENIED` e vê "pedido
   recusado"; pedir de novo é gesto dele, nunca do laço de reconexão.

## Protocolo (versão 3)

- `watch` passa a exigir `name` e `viewerKey`. Sem eles, `BAD_MESSAGE`.
- Convite válido: o espectador recebe `awaiting-approval` e o dono recebe
  `join-request {peerId, name, fingerprint}`. **Nada de vaga nem credencial
  TURN antes do `admit`** — o mesmo ponto de encaixe do convite.
- `admit {peerId}` segue a entrada de sempre (`watching`, `peer-joined`, agora
  com `name` e `fingerprint`). `deny {peerId}` fecha com `DENIED`. Só o host
  atual responde.
- Quem desiste ou cai antes da resposta vira `join-cancelled` para o dono.
- Canal cheio na hora do pedido: `CHANNEL_FULL` sem chegar ao dono. Encheu
  enquanto esperava: `CHANNEL_FULL` no `admit`, e `join-cancelled` para o dono.
- Fila com teto (`maxPending`, 8): excedente recebe `RATE_LIMITED`.
- Dono que reconecta recebe de novo os pedidos em espera; dono que encerra
  derruba quem esperava com `NOT_HOSTING`.
- Retomar a vaga (mesmo `participantId`) exige a mesma chave: o socket que caiu
  e voltou antes de o servidor notar não pede de novo; outro navegador com o
  mesmo `participantId` vira pedido.
- Cliente v2 recebe `PROTOCOL_MISMATCH` ("recarregue"). Aceitá-lo seria deixar
  entrar sem pedir.

O servidor não guarda nada durável: o pedido vive na conexão (no Node, na
closure; no Durable Object, no attachment do socket, que sobrevive à
hibernação). A lista de aprovados vive no navegador do dono.

## Implantação

Front e sinalização sobem juntos no mesmo Worker. Abas abertas antes do deploy
falam v2 e passam a ver "página desatualizada": recarregar resolve.

## Consequências

- O espectador espera sem relógio: o `watch` não expira enquanto o pedido está
  com o dono, que pode estar no meio de uma partida.
- A lista de aprovados é por aparelho do dono. Transmitir de outro computador
  pede todo mundo de novo — o mesmo trade-off do convite.
- Limpar o armazenamento do navegador do espectador gera outra chave: ele pede
  de novo.
