# ADR 0023 — Colapso de link e sonda de subida

**Data:** 2026-09-28
**Estado:** aceita
**Tarefa:** TELA-015 · **Complementa:** ADRs 0015, 0017, 0018, 0019 · **Mantém:** R5

## Contexto

As duas guardas do teto de upload (`limitadosPorPixel`, `encoderOcioso`)
impediam o orçamento de cair quando a leitura de banda refletia a nossa
própria atuação — teto de pixel do degrau, ou cena parada. Nenhuma distinguia
isso de um colapso de rede: num colapso o envio cai junto com a estimativa. O
código registrava o defeito como aberto, com três tentativas medidas e
reprovadas. No simulador, a sub-matriz de queda (link a 15 % por 30 s) não
reagia em nenhum dos 24 cenários.

## Decisão

1. **Evidência de colapso.** Três leituras seguidas de
   `qualityLimitationReason === 'bandwidth'` liberam a queda mesmo com as
   guardas ativas. As guardas não mudam; ganham a evidência que não tinham.
   A queda continua exigindo que a ESTIMATIVA caia ≥ 30 % — o motivo sozinho
   não derruba nada.
2. **Sonda de subida.** Descer por colapso leva a um degrau cujo teto de
   pixel prende `acked`, e o `1,5×acked` do libwebrtc não deixa o orçamento
   alcançar o degrau de cima (a armadilha da ADR 0018, do outro lado). Depois
   de uma descida por colapso, a sessão sobe UM degrau quando a estimativa
   está colada em `1,5×acked` (somos nós o limitador) e passaram `sondaEspera`
   amostras sem decisão. Queda dentro da janela = sonda falhou, e a espera
   dobra (15 → 240 s). Link pequeno alcançado sem colapso não é sondado.
3. A espera conta desde a última decisão, e NÃO desde o último `bandwidth`:
   medido em Chrome real, o motivo fica em `bandwidth` continuamente com
   link farto quando o conteúdo é pesado — é o quality scaler, que o
   libwebrtc atribui a banda.

## Medido

`e2e/malhas.sim.mjs` (1200 cenários), antes → depois:

| métrica | antes | depois |
|---|---|---|
| > 10 % do tempo pedindo mais do que o link tem | 135 | 81 |
| bpp entregue < 0,10 | 70 | 70 |
| rótulo mente | 4 | 4 |
| abaixo de 80 % do que o link pagava | 138 | 138 |
| estado absorvente | 1 | 1 |
| reconfigurações (mediana) | 20 | 25 |

`--quedas`: queda de 30 s — reage em 21 de 24 (os 3 restantes têm folga para
não precisar) e volta em todos, três deles devagar (90 % do bitrate de antes
em 150 s). Colapso sustentado (novo, cai a 10 % e fica): antes nunca reagia,
com 0,012–0,08 bpp a 1080p60 e a tela calada; depois reage em 2 s em 5 de 6,
desce ao degrau que o link paga e mostra "banda" como motivo.

`e2e/banda.e2e.mjs`, Chromium 1234 real: link de 1,5 Mbps desde a conexão →
1080p60 sai para 360p60 em 15 s com motivo `bandwidth`; ao tirar o limite, o
BWE da conexão viva sobe e o degrau acompanha. O CDP não estrangula uma
conexão já aberta, então o colapso EM conexão viva ficou só no simulador.

## Custo aceito

Cinco reconfigurações de encoder a mais na mediana de 300 s. Troca por um
terço menos de cenários enchendo o cano do usuário — que é o que faz o ping
do jogo subir.

## Não verificado

Colapso numa conexão viva em rede real (`tc netem` no transmissor, ou trocar
de Wi-Fi para 4G no meio). Roteiro em `docs/qa/TELA-015-colapso.md`.
