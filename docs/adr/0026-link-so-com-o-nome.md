# ADR 0026 — O link é só o nome do canal

**Data:** 2026-09-28
**Estado:** aceita
**Substitui:** as decisões 1–4, 6 e a parte de `set-invite` da 8 da ADR 0021
**Mantém:** ADR 0025 (aprovação manual), R6, R8

## Contexto

A ADR 0021 pôs um segredo no fragmento do link (`tela.gg/jv#k=<convite>`):
sem ele, ninguém entrava. Era a única porta da sala. A ADR 0025 criou uma
segunda: o dono aceita cada pessoa, e nada de vaga nem credencial TURN sai
antes do aceite. Com a segunda porta, a primeira passou a cobrar sem entregar
— um link que não se dita numa call, que quebra quando colado pela metade, e
um "renovar convite" que o dono precisa entender.

O dono pediu o link só com o nome (2026-09-28).

## Decisão

1. **O link é `origem/<slug>`.** Sem fragmento, sem segredo.
2. **A porta é a aprovação (ADR 0025).** Quem abre o link pede para entrar; o
   servidor segura vaga e TURN até o `admit`, como já fazia.
3. **Sem "renovar convite".** O que ele fazia além de trocar o link — zerar a
   lista de aceitos — fica com "desconectar todos".
4. **Links antigos continuam abrindo.** O `#k=` é ignorado: quem guardou o link
   da ADR 0021 cai no pedido normal.
5. **Protocolo 4.** `host`/`watch` sem `invite`; saem `set-invite`,
   `invite-set` e `INVITE_INVALID`. Aba aberta na 3 recebe
   `PROTOCOL_MISMATCH` ("recarregue"), em vez de um erro no meio do ar ao
   clicar num botão que não existe mais.

## O que se perde, e por que se aceita

- **Quem adivinha o nome descobre que alguém está no ar**, e pode mandar um
  pedido. A ADR 0021 escondia isso (`NOT_HOSTING` igual para tudo sem convite).
  Aceito porque o pedido não dá nada sem o aceite: nem vaga, nem credencial
  TURN, nem um quadro de vídeo. Continua valendo a igualdade que protege nomes
  FORA do ar: sem transmissão, inexistente e offline dão o mesmo `NOT_HOSTING`.
- **Pedido indesejado vira ruído na fila do dono.** A fila tem teto (8) e cada
  conexão tem limite de mensagens; recusar é um clique e não precisa de
  confirmação.
- **O convite deixava a credencial TURN fora do alcance de quem só sabia o
  nome.** Continua fora: ela só sai depois do `admit` (ADR 0025).

## Implantação

Front e sinalização sobem juntos no mesmo Worker. `tela.convite` fica esquecido
no navegador de quem já transmitiu; `forget()` ainda o apaga.
