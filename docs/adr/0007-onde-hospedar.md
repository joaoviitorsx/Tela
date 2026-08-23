# ADR 0007 — Onde hospedar o front e a sinalização

**Status:** aceita · **Data:** 2026-08-23
**Origem:** changeset 001 §5 — *"verifique os limites atuais do free tier
escolhido antes de fixar a plataforma e registre a escolha num ADR"*

## Contexto

A restrição é dura: **orçamento zero, permanente**. Não é "barato", é zero — e
sem cartão de crédito exigido, porque um cartão numa conta de projeto pessoal
é uma fatura esperando um pico de tráfego.

São duas peças com necessidades diferentes:

1. **Front** — arquivos estáticos. Praticamente qualquer lugar serve.
2. **Sinalização** — WebSocket com conexões longas e majoritariamente ociosas.
   Uma transmissão de três horas mantém quatro sockets abertos que trocam
   alguns kilobytes no primeiro segundo e depois quase nada.

Esse perfil — muitas conexões abertas, pouquíssimo tráfego — é o pior caso
para quase todo modelo de cobrança gratuito, porque a maioria cobra por tempo
de processo no ar, e não por trabalho feito.

## O que foi verificado (agosto/2026)

| Plataforma | Situação | Veredito |
|---|---|---|
| **Vercel, Netlify** | Node roda como função serverless; sem conexão persistente | Não serve — não há WebSocket |
| **Fly.io** | Free tier encerrado para contas novas: trial de 2h de VM ou 7 dias, depois cartão obrigatório | Não serve — deixou de ser gratuito |
| **Render** | Free tier existe, mas o serviço dorme por inatividade e tem cold start | Arriscado — o keepalive é do servidor para o cliente, e pode não contar como tráfego de entrada |
| **Koyeb** | Instância gratuita real, mas escala a zero após 1h sem tráfego; cartão pedido para verificação | Viável como alternativa |
| **Railway** | WebSocket em todos os planos, mas o gratuito virou crédito de trial | Não serve a longo prazo |
| **Cloudflare Workers + Durable Objects** | Free tier desde abril/2025: 100.000 requisições/dia e 313.000 GB-s/dia. **WebSocket Hibernation**: o objeto é despejado da memória enquanto os sockets seguem abertos, e tempo ocioso não é cobrado. Ping/pong do protocolo é respondido pelo runtime e **não interrompe a hibernação** | **Escolhido** |

## Decisão

**Front:** Cloudflare Pages. **Sinalização:** Cloudflare Workers + Durable
Objects, um objeto por slug.

O argumento decisivo é a hibernação. Nas outras plataformas você paga (em
tempo de processo, em cota de sono, em cold start) por segurar uma conexão que
não está fazendo nada — e "não fazer nada" é 99,9% da vida de um socket de
sinalização. O Cloudflare é a única que cobra por trabalho, e o trabalho aqui é
o handshake de alguns kilobytes.

`idFromName(slug)` faz todos os peers de um canal caírem na mesma instância.
Isolamento por canal sai de graça, sem roteamento nosso.

## O custo: duas implementações do servidor

`server.ts` (Node + `ws`) continua existindo e continua sendo o padrão para
rodar local, numa VPS ou em qualquer outro free tier. `worker-entry.ts` +
`worker.ts` são o alvo do Cloudflare.

**Por que não uma só.** Sob hibernação o objeto perde memória e closures: a
fonte da verdade passa a ser `ctx.getWebSockets()` e o que foi anexado a cada
socket com `serializeAttachment`. O registro do Node guarda `Map` e closures.
Não é preguiça nem falta de abstração — é modelo de estado genuinamente
diferente, e forçar um denominador comum deixaria os dois piores.

**Como isso não vira dívida.** Existe `conformance.test.ts`: uma bateria de 18
expectativas observáveis do lado do cliente, que roda contra as **duas**
implementações. Um comportamento que mude de um lado só quebra o build. Os
schemas do protocolo e os limites já eram compartilhados via `@tela/shared`.

Vale registrar o que a suíte já provou: as duas concordam até no detalhe de
que um `signal` sem `payload` é `BAD_MESSAGE` e derruba a conexão.

## Consequências

- **Free tier com teto diário.** 100k requisições/dia. Cada mensagem de
  sinalização conta; uma transmissão típica gasta dezenas, não milhares. Se um
  dia estourar, a degradação é clara (erro), não silenciosa.
- **Dependência de plataforma no deploy recomendado.** Mitigada pelo servidor
  portátil, que continua verde no CI e roda em qualquer lugar.
- **TURN continua sendo de terceiro.** O Cloudflare não oferece TURN no plano
  gratuito. A cauda de conexões atrás de CGNAT simétrico depende de um relay
  externo com cota — é a limitação já declarada na ADR 0002, e não muda aqui.
- **O slug segue efêmero.** O Durable Object não escreve em storage: o estado
  de dono vive na memória do objeto e nos attachments. Hibernação preserva os
  attachments; um redeploy do Worker limpa tudo, e isso é aceitável.

## Alternativa mantida em aberto

Se a cota diária virar problema, **Koyeb** é o próximo da fila: roda `server.ts`
sem modificação nenhuma, e a única mudança é apontar `VITE_SIGNAL_URL` para
outro host. Foi por isso que o servidor portátil não foi descartado.

## Sources

- <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- <https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/>
- <https://developers.cloudflare.com/durable-objects/platform/pricing>
- <https://expresstech.io/7-fly-io-alternatives-in-2026-real-pricing-after-the-free-tier-died/>
- <https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026>
- <https://www.srvrlss.io/provider/koyeb/>
