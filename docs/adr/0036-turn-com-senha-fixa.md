# ADR 0036 — TURN com senha fixa de plano grátis, só com aceite explícito

**Data:** 2026-10-03
**Estado:** aceita (o dono escolheu o ExpressTURN grátis com os riscos abaixo, 2026-10-03); vale quando `TURN_ESTATICO = "aceito"` for gravado
**Altera:** a regra registrada em `apps/signaling/src/ice.ts` ("credencial estática num front público é um relay aberto") · **Mantém:** a credencial efêmera como padrão (Cloudflare, coturn com segredo)

## Contexto

A produção ficou sem relay de 2026-09-28 a 2026-10-03 (secrets do TURN da
Cloudflare gravados vazios). Quem está atrás de CGNAT, NAT simétrico ou
firewall não conecta sem relay — o relato que trouxe isto foi um espectador
com `ice: NO_ROUTE` e `turn: RELAY_NOT_CONFIGURED`.

O TURN da Cloudflare (1.000 GB grátis por mês, credencial efêmera) exige
cartão, e o dono não tem como pôr. O plano grátis do ExpressTURN não exige
cartão (1.000 GB por mês), mas só oferece **usuário e senha fixos**; o
segredo compartilhado, que daria credencial que expira, é do plano pago.

## Decisão

O Worker entrega `TURN_USERNAME`/`TURN_PASSWORD` com `TURN_URLS` só quando
`TURN_ESTATICO = "aceito"`. Sem o aceite, credencial fixa continua recusada.
Segredo compartilhado (coturn) e Cloudflare vencem a senha fixa. A credencial
vai sem `expiresAt`, e o cliente não pede renovação para ela.

## Riscos (o dono aceita ao ligar)

1. **Qualquer um consegue a senha, sem link:** basta abrir a sinalização
   como transmissor de um canal qualquer. Os limites de emissão não ajudam —
   uma vez basta, e a senha não vence.
2. **Cota:** alguém pode gastar os 1.000 GB de propósito e deixar o relay
   fora até o mês virar. Sem custo em dinheiro (plano grátis, sem cartão).
3. **Proxy anônimo:** o relay pode ser usado para tráfego de terceiros, e o
   abuso é atribuído à conta do dono no ExpressTURN — risco de suspensão.
4. **Troca de senha** derruba quem estiver no relay e exige `secret put` +
   `pnpm release`.
5. A senha do TURN não pode ser a de login da conta do provedor.

## Por que, mesmo assim

Hoje não há relay nenhum: a minoria atrás de NAT restritivo simplesmente não
assiste. Com a senha fixa, ela assiste; no pior caso, volta a não assistir —
sem custo. O risco 3 é o que pesa, e é decisão do dono.

## Sair dela

Assim que houver cartão (Cloudflare) ou um coturn próprio com
`TURN_SECRET`, gravar esse e apagar `TURN_USERNAME`/`TURN_PASSWORD`: a
credencial efêmera vence sozinha.

## Diferença Node × Worker

O servidor Node (`apps/signaling/src/server.ts`, self-host) continua recusando
credencial fixa em produção. Só o Worker, que é a produção, tem o aceite.

## Verificação

`check-prod` não verifica senha fixa (o servidor a entrega sem consultar o
provedor) e diz isso; `node e2e/relay-prod.mjs` faz o Allocate autenticado e
mostra por qual transporte cada relay foi alcançado.
