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

## Decisão (revisada no mesmo dia, depois da revisão independente)

A primeira versão usava só um limiar de consumo (produzido ÷ alvo < 0,5) e
"passava" no simulador — porque o simulador injetava um consumo fixo de
0,12. A revisão independente mostrou que no "um encode" real o alvo do
encoder é FREADO pela estimativa (`0,85 × estimativa`): numa tela parada a
estimativa decai a `1,5 × envio`, o alvo encolhe junto e o consumo converge
a ~0,78. A guarda desarmava sozinha. O simulador agora calcula o consumo como
o produto (produzido ÷ alvo freado), e a decisão passou a ser:

1. O codificador único informa `consumoDoEncoder` (produzido ÷ alvo freado).
2. `bandwidth` só PROVA colapso quando:
   - o encoder está **enchendo** o alvo (consumo ≥ 0,95) e a estimativa
     **não está subindo** (tendência de 5 amostras; subir > 10% é rampa) —
     o colapso clássico, igual a antes com conteúdo em movimento; **ou**
   - há **congestão**: RTT acima de `patamar × 1,5 + 15 ms` (o patamar é o
     menor RTT visto, subindo 0,5 ms por amostra) — o link está cheio,
     qualquer que seja o conteúdo.
3. Encoder sem encher o alvo e sem congestão (tela parada, conteúdo leve)
   não prova nada; uma amostra que não prova não SOMA, mas não zera — ruído
   não reinicia a contagem de um colapso real.
4. Sem `consumoDoEncoder` (fora do "um encode") o comportamento é o antigo.
5. `reiniciar()` zera tudo (a primeira versão deixava o estado da sessão
   anterior desarmando o colapso da seguinte).
6. O NVENC em VBR entra como ajuste EXPERIMENTAL do app, desligado
   ("Economizar banda com a tela parada"): `taxa vbr|cbr` no helper (por
   nome, `gst_util_set_object_arg`), teto do VBR = orçamento.

## Medido (simulador com consumo honesto e teto de sonda modelado)

- `--parado`, antes: orçamento derrubado em **12/12**, nenhum voltando.
- `--parado`, depois: orçamento derrubado em **2/12** (os dois de 10 Mbps
  com 3 e 5 pessoas, que já operam no limite; voltam em ~25 s); de 50 Mbps
  para cima o degrau se segura em 1080p depois da pausa (50 Mbps com 5
  desce a 600p de passagem).
- Portões: 73/0/0/128/84 (antes 72/0/0/128/83, dentro da margem);
  `--escala` 0/0/0/0; colapsos reais (`--quedas`) seguem reagindo em 2 s.

## Não medido

Rede real: se o RTT do Chromium sobe como o modelo supõe num colapso, e a
velocidade com que a estimativa reabre depois de uma pausa (com as sondas
que o `x-google-max-bitrate` liberou). Por isso o NVENC em VBR é opt-in até
medir.
