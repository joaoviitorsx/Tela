# ADR 0033 — Tela parada não é colapso de link

**Data:** 2026-10-03
**Estado:** aceita
**Complementa:** ADR 0018 (a malha mede a própria atuação), TELA-015 (colapso de link) · **Mantém:** R5, ADR 0015, 0017, 0030

## Contexto

O estudo 1-codec (§5) mediu que, em CBR, o NVENC enche a banda até com a
tela parada: 12 Mbps contra 1,4 Mbps em VBR, mesmo PSNR. O ganho de passar a
VBR é grande, mas o estudo condicionou a um cenário "parado → jogo" no
simulador, por causa da ADR 0018.

O cenário foi escrito (`node e2e/malhas.sim.mjs --parado`: encoder a 12% do
alvo por 60 s, depois o jogo volta). Resultado com o código de antes:
**12 de 12 cenários perdiam o orçamento na pausa e 11 nunca voltavam do 360p
— nem num link de 800 Mbps.**

A cadeia: na pausa o envio cai, a estimativa decai a `1,5 × enviado`, o motivo
vira `bandwidth`, três amostras disparam a guarda de colapso (TELA-015) — que
passa por cima da guarda de cena parada (`encoderOcioso`) — e o orçamento
cai; depois disso a catraca da ADR 0018 não o devolve.

E o encoder WebCodecs do app já é VBR (`bitrateMode: 'variable'`): a mesma
cadeia podia acontecer HOJE, num menu.

## Decisão

1. O codificador único informa `consumoDoEncoder` = bits produzidos ÷ alvo
   dado ao encoder. É um sinal que NÃO depende da rede: num colapso o
   encoder do "um encode" continua produzindo o alvo (quem segura é o
   pacer); numa tela parada ele produz uma fração.
2. Consumo < 0,5: `bandwidth` não conta como colapso. E por 20 amostras
   depois da pausa também não — o movimento volta com a estimativa ainda
   baixa, e é exatamente aí que a catraca derrubaria o degrau.
3. Fora do "um encode" o campo não existe e nada muda.
4. O NVENC em VBR entra como ajuste EXPERIMENTAL do app, desligado
   ("Economizar banda com a tela parada"): `taxa vbr|cbr` no helper, teto
   do VBR = orçamento.

## Medido

- `--parado` depois: orçamento caiu na pausa em **0/12**; o degrau na volta
  é o de antes em 12/12; a partir de 50 Mbps o pior degrau depois da pausa é
  1080p; nos links apertados (10 Mbps; 50 Mbps com 5) há uma descida
  passageira de um degrau enquanto a estimativa reabre.
- Portões de sempre idênticos (72/0/0/128/83; `--escala` 0/0/0/0); os
  colapsos reais (`--quedas`) continuam reagindo em ~2 s.
- O modelo do simulador foi corrigido junto: na pausa o encoder produz um
  valor ABSOLUTO (fração do alvo do encoder), e não uma fração do que a
  rede deixa sair — a versão inicial derrubava a estimativa a 30 kbps.

## Não medido

Rede real: a velocidade com que a estimativa reabre no libwebrtc (com as
sondas que o `x-google-max-bitrate` liberou) e o VBR do NVENC na prática.
Por isso o NVENC em VBR é opt-in até medir.
