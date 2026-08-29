# ADR 0017 — O governador mede ORÇAMENTO, não teto

**Data:** 2026-08-29
**Estado:** aceita
**Corrige:** ADR 0015 (que consertou metade do problema)
**Altera:** o contrato de `UplinkGovernor` e da porta `MediaTransport`

## Contexto

A ADR 0015 consertou o caso da escassez: um orçamento de 3 Mbps parou de ir
para um quadro de 1920×1080 e passou a escolher a resolução que os bits pagam.

Aí veio o relato que a 0015 não cobre: **link de 800 Mbps de subida, e a
imagem continua ruim.**

A aritmética explica em três linhas:

```
estimativa por espectador  = 800 / 2 = 400 Mbps
orçamento (×0,75)          = 300 Mbps
limiar de entrada do teto  = 12 Mbps × 0,9 = 10,8 Mbps

300 Mbps >>> 10,8 Mbps  →  nenhum teto aplicado  →  ceiling = null
```

E em `mesh-topology.ts`:

```ts
private effectiveBitrate(preset) {
  if (this.ceiling === null) return preset.main.maxBitrate;  // 12 Mbps. Fim.
  …gasta o orçamento até BPP_TETO…
}
```

**O caminho que gastava a banda medida existia — e estava trancado atrás da
escassez.** Quem tinha banda de sobra nunca chegava nele e caía no nominal do
preset.

E o nominal é o quê? 12 Mbps em 1920×1080@60 são **0,096 bit por pixel**. Esse
número é o **piso** da ADR 0010: o ponto onde a imagem para de quebrar. Não é o
ponto onde ela fica boa. Conteúdo de movimento alto — teamfight de LoL, com a
tela inteira mudando de quadro para quadro — pede 0,15 a 0,20.

**0,20 bpp em 1080p60 são 24,9 Mbps.** O usuário tinha 300 Mbps de orçamento
por espectador e estava recebendo 12.

## A causa profunda: um nome que descrevia meia função

`UplinkGovernor` se chamava governador de **teto**, e teto só fala para
apertar. O silêncio dele era ambíguo por construção — "não há o que restringir"
e "não medi nada" eram o mesmo retorno `null`, e quem consumia o silêncio não
tinha como distinguir. Caía no nominal nos dois casos.

O mesmo pelo lado da porta: `setBitrateCeiling(bps: number | null)`, com
`null` significando "remova o teto". Nunca existiu um jeito de dizer "o link
comporta 300 Mbps".

## Decisão

**O governador passa a reportar o ORÇAMENTO por espectador, sempre que ele
muda de forma relevante — para cima ou para baixo.**

- `observe(availableBps)` devolve `{ bps }` ou `null` (não mexa). O terceiro
  retorno, `{ bps: null }` ("solte o teto"), deixa de existir junto com a ideia
  de teto.
- O parâmetro `preset` sai da assinatura. Medir banda não depende de saber a
  resolução, e a dependência só existia para comparar com o nominal.
- A **histerese de fronteira** (`ENTRA_ABAIXO_DE` / `SOLTA_ACIMA_DE`, o gatilho
  de Schmitt) sai também: ela existia para não alternar entre dois regimes, e
  não há mais dois regimes. Sobra a histerese de valor, 25%, que é a que
  impede a oscilação real.
- A porta vira `setUplinkBudget(bps)`. Quem gasta é a topologia, que sabe a
  resolução: `min(orçamento, BPP_TETO × largura × altura × fps)`.

Com isso, os três regimes ficam corretos com a mesma expressão:

| orçamento/espectador | degrau escolhido | bitrate aplicado | bpp |
|---|---|---|---|
| 3 Mbps | 854×480@60 | 3,0 Mbps | 0,122 |
| 18 Mbps | 1920×1080@60 | 18,0 Mbps | 0,145 |
| 300 Mbps | 1920×1080@60 | **24,9 Mbps** | **0,200** |

## Bug adjacente, corrigido junto

`effectiveBitrate` fazia `min(max(nominal, orçamento), útil)`. O `max`
**furava o orçamento em modo `nitidez`**: a 30fps o degrau escolhido pode ter
nominal de até o dobro do que o link paga, e o `max` mandava o nominal. Um
orçamento de 3 Mbps virava 5,5 Mbps de demanda — o afogamento que o governador
existe para impedir, produzido por ele. Agora é `min(orçamento, útil)`, e só.

## Outros dois defeitos que a revisão do pipeline achou

**1. `applyConstraints` descartava as constraints de resolução.**

`applyConstraints` **substitui** o conjunto inteiro; não faz merge. O throttle
de ociosidade mandava `{ frameRate: 5 }` sozinho, e isso apagava `width`,
`height` e `resizeMode` da trilha de captura.

Não é canto raro: **toda** transmissão começa sem espectador, cai para 5fps em
dez segundos e volta quando o primeiro amigo entra. A partir dessa volta um
monitor 1440p ou 4K passava a entregar quadros nativos 60 vezes por segundo, e
o redimensionamento virava trabalho extra na mesma máquina que roda o jogo —
exatamente o custo que `crop-and-scale` existe para evitar.

O sintoma final não é resolução errada (o `scaleResolutionDownBy` corrige a
saída), é **CPU**: mais custo por quadro → `qualityLimitationReason: 'cpu'` →
a escada derrubando qualidade por um problema que a otimização de ociosidade
criou.

**2. Escala medida cedo demais ficava errada para sempre.**

`escalaPara` lê `track.getSettings().width`, e uma trilha recém-criada pode
reportar `0` — caso em que a função devolve `1` por segurança. Um `1` errado
significa mandar 1920×1080 com o bitrate de um degrau menor, que é literalmente
a definição de quadriculado.

O agravante era que nada corrigia: `applyPreset` só roda de novo em troca de
preset, orçamento, prioridade ou trilha, e um sender que **aceitou** os
parâmetros errados não entra na fila de pendentes. Agora a escala é reconferida
no relógio de estatísticas que já existe, com 1% de banda morta.

**3. A recuperação de CPU congelava sob pressão de banda.**

A guarda da ADR 0015 que impede a escada de contar banda em dobro retornava
antes de chamar `recuperar()`. Com o orçamento apertado e o Chromium reportando
`bandwidth` continuamente, a calmaria nunca avançava e uma queda causada por um
transiente de CPU ficava marcada para sempre. Subir ali é seguro por
construção: `aplicarDegrau()` corta no orçamento, então nem um bit a mais sai
do link.

## Consequências

**Uma reconfiguração do encoder no início de toda transmissão.** O governador
agora fala quando o aquecimento termina, mesmo com banda de sobra. Antes eram
zero nesse caso. É o preço de gastar a banda que existe, e a histerese de 25%
continua absorvendo todo o resto — o teste de ruído ±20% segue exigindo
**nenhuma** reconfiguração depois da primeira.

**O consumo sobe onde há banda.** 1080p60 pode chegar a 24,9 Mbps por
espectador em vez de 12. Com cinco espectadores são 125 Mbps de subida — 15% de
um link de 800. Onde o link não comporta, o próprio orçamento medido corta
antes.

**`BPP_TETO = 0,20` virou o teto de qualidade de todo mundo com banda.** É o
topo da faixa útil para movimento alto em H.264 realtime; acima disso o
encoder encosta no piso de QP e o bit deixa de virar imagem. É a constante a
mexer se algum dia isso mudar.

**O fake de trilha ganhou `getSettings`.** Ele não tinha, então `escalaPara`
devolvia `1` em todos os testes — e foi assim que um `scaleResolutionDownBy`
sobrescrito por um spread passou despercebido. Fake que não modela a coisa
certa não testa nada.

## O que continua sem verificação

1. Confirmar em `chrome://webrtc-internals`, no link de 800 Mbps, que
   `targetBitrate` do `outbound-rtp` chega perto de 24,9 Mbps e que
   `frameWidth` fica em 1920.
2. Conferir a linha **densidade** no console: deve marcar ~0,20 em vez de
   ~0,096.
3. Confirmar que 24,9 Mbps por espectador não afoga o DOWNLINK de nenhum
   espectador — a adaptação é coletiva (R5), então um espectador com 20 Mbps de
   descida puxa todo mundo para baixo, e isso é por projeto.
4. Medir se o `x-google-start-bitrate` em 24,9 Mbps produz um pico inicial
   perceptível. Na primeira conexão ele vale o nominal (12 Mbps), porque ainda
   não há medição — mas peers que entram depois começam no valor cheio.
