# ADR 0015 — O teto de upload escolhe o degrau, não só o bitrate

**Data:** 2026-08-28
**Estado:** aceita
**Altera:** R5 (o `contentHint` passa a acompanhar a prioridade)
**Corrige:** a malha de controle da ADR 0009; completa a ADR 0010

## Contexto

Um transmissor em Campinas, dois espectadores, 58ms de RTT. A imagem chegava
**borrada** — texto de HUD ilegível, partículas viradas em mancha.

Borrado não é quadriculado, e a diferença é o diagnóstico inteiro:

- **quadriculado** é QP alto: bits de menos para a resolução que está sendo
  enviada;
- **borrado** é resolução baixa esticada: o encoder desistiu dos pixels e o
  espectador fez upscale.

Com 58ms e dois espectadores, a rede não era o problema. O produto estava se
sabotando.

### A causa

Em `mesh-topology.ts`, os dois parâmetros que decidem a qualidade vinham de
fontes diferentes:

```ts
scaleResolutionDownBy: escalaPara(sender.track, preset),  // ← do PRESET
maxBitrate: this.effectiveBitrate(preset),                // ← do TETO
```

`effectiveBitrate()` era `min(preset.maxBitrate, teto)`. `escalaPara()` ignorava
o teto por completo.

Ou seja: **o teto de upload sempre cortou BITS e nunca cortou PIXEL.** E
`maxBitrate` sozinho não tira um pixel do encoder — só aperta o QP. É o mesmo
corolário que a R5 já enunciava para a escada manual, e que a malha automática
violava.

A aritmética, com dois espectadores:

| upload | por espectador | teto (×0,75) | degrau ativo | bpp real |
|---|---|---|---|---|
| 30 Mbps | 15 Mbps | sem teto | 1080p60 @ 12 Mbps | 0,096 ✅ |
| 20 Mbps | 10 Mbps | 7,5 Mbps | **1080p60** @ 7,5 Mbps | **0,060** ⚠️ |
| 10 Mbps | 5 Mbps | 3,75 Mbps | **1080p60** @ 3,75 Mbps | **0,030** 💀 |

A ADR 0010 fixou 0,10 bpp como piso e condenou a tabela antiga por entregar
0,064. A malha automática entregava **0,030** — metade do valor reprovado.

E havia um segundo estágio, invisível: abaixo do piso, o *quality scaler* do
Chromium começa a derrubar resolução por conta própria, e essa queda **compõe**
com o `scaleResolutionDownBy` que já aplicamos. Duas adaptações multiplicando,
nenhuma delas medida.

A ironia é que `presetForBitrate()` já existia em `@tela/shared`, com um
comentário descrevendo exatamente este defeito. **Ninguém a chamava** fora da
sugestão inicial.

### O agravante

`recuperar()` recusava subir de degrau enquanto `governor.ceiling !== null`. O
raciocínio era defensável — teto em vigor significa banda apertada, e subir
seria cair de novo. Só que o teto quase nunca largava, então uma degradação
disparada por um transiente de CPU virava **permanente pelo resto da sessão**.
É o "embaçou e não voltou" dos relatos.

## Decisão

### 1. O orçamento vira degrau, não só bitrate

Quando o governador aplica um teto, a sessão traduz esse teto em resolução via
`presetParaOrcamento()`. Os mesmos 3 Mbps que rendiam 0,030 bpp em 1080p60
rendem **0,122 bpp em 854×480@60**: 480p60 nítido de verdade, num rótulo menor.

É o que o Discord faz. A documentação de engenharia deles diz, literalmente,
que resolução, framerate e qualidade são derivados da banda estimada — nunca
fixados por rótulo.

### 2. Três pressões, e vale a que aperta mais

Havia um `presetId` mutável só, e três fontes escrevendo nele: a escolha do
usuário, a escada de pressão sustentada e (agora) o orçamento de banda. A
última a escrever apagava as outras.

Passam a ser campos separados, e o efetivo é o pior dos três
(`aplicarDegrau()`). Estado impossível deixa de ser representável: não existe
mais "o usuário escolheu 1080p, então mande 1080p" atropelando um orçamento de
3 Mbps.

### 3. O teto vira ALVO quando é maior que o degrau

`effectiveBitrate` era `min(preset, teto)`. Com o degrau já derivado do
orçamento, o `min` desperdiçava banda medida: teto de 3 Mbps escolhe `p480p60`,
cujo nominal é 2,5 — e os 500 kbps restantes, num quadro de 854×480, são a
diferença entre 0,10 e 0,12 bpp.

Agora o teto vence quando é maior, com clamp em `BPP_TETO` (0,20), acima do
qual o bit não vira imagem em movimento alto.

### 4. A referência do governador passa a ser o preset ESCOLHIDO

Era o corrente. Com o teto definindo o degrau, uma referência móvel vira
oscilador: degrada para 480p60, o limiar de soltura cai junto, o teto solta, o
degrau volta a 1080p60, o limiar sobe, o teto reaplica — uma vez por segundo,
para sempre.

O escolhido não se move sem o usuário mandar. A objeção original a essa
referência ("o teto nunca soltava, e a recuperação exigia teto nulo") deixa de
existir junto com o acoplamento que a produzia.

### 5. A recuperação destrava

A guarda `governor.ceiling !== null` sai. O piso de banda continua valendo por
construção — a escada de pressão sobe, e `aplicarDegrau()` corta no que o link
paga. Nunca se pede mais do que o teto dá, e nunca se fica preso embaixo
quando a CPU já se resolveu.

### 6. A escada de pressão para de contar banda em dobro

Consequência direta da decisão 1, e ela mesma um defeito: com o teto derrubando
o degrau, o Chromium continua reportando `qualityLimitationReason: 'bandwidth'`
— porque É banda, e a malha está funcionando. A escada de pressão lia isso como
um segundo problema e derrubava o degrau de novo a cada cinco leituras, até o
fundo.

Duas malhas reagindo à mesma pressão compõem, exatamente como o quality scaler
do Chromium compõe com o `scaleResolutionDownBy`. E o retorno era pior: o
degrau ficava marcado lá embaixo na escada de pressão, que leva 60 amostras
POR degrau para desfazer uma queda que nunca foi dela.

`bandwidth` agora só move a escada quando o governador **não tem estimativa** —
o navegador que não reporta `availableOutgoingBitrate`, onde a escada é a única
defesa que sobra.

### 7. `nitidez` passa a mexer em pixel (altera a R5)

O modo trocava só o `degradationPreference` — pedia ao encoder para preservar
resolução sem lhe dar um bit a mais por quadro para isso. Metade do controle
não fazia nada.

Agora `nitidez` também:

- corta o framerate alvo para **30fps**, o que **dobra** os bits por pixel
  disponíveis e faz caber um degrau maior pelo MESMO orçamento — 1280×720@30
  onde `fluidez` entrega 854×480@60;
- troca o `contentHint` para `detail`, que no Chromium liga o caminho de
  conteúdo de tela: preserva resolução, corta quadros. É o parâmetro que de
  fato decide isso, e ele continuava em `motion`.

**A R5 continua travando `motion` e `maintain-framerate` como PADRÃO.** Isto é
a escolha explícita do usuário que a ADR 0009 abriu, agora implementada
inteira.

### 8. A captura sempre pede a resolução ESCOLHIDA

`switchSource()` pedia a resolução do degrau CORRENTE. Como a resolução da
trilha é fixada uma vez pelo `getDisplayMedia` e não volta a subir, trocar de
janela durante uma degradação criava um teto permanente.

## Consequências

**O rótulo cai antes da imagem.** Cinco espectadores num link de 20 Mbps veem
`480p60` escrito na tela em vez de `1080p60`. É honesto, e é a imagem melhor:
0,10 bpp em 480p é nítido; 0,024 bpp em 1080p é a foto do relato.

**A conta que não muda.** Malha P2P envia N cópias. Para 1080p60 real com cinco
espectadores são ~60 Mbps de subida. Nenhuma destas mudanças cria banda — todas
extraem mais imagem dos mesmos bits. O Discord resolve isso com SFU (um upload,
o servidor replica); nós não temos servidor de mídia por decisão de
arquitetura (ADR 0005), e o preço é este.

**Um número novo no diagnóstico.** `MediaStats.bpp` e a linha "densidade" no
console. Era a única grandeza do pipeline que ninguém media, e a que teria
apontado o defeito no primeiro dia.

## Alternativas descartadas

**Só baixar o `maxBitrate` e confiar no navegador.** É o que estava lá. O
quality scaler do Chromium cascateia sem teto e sem aviso, e a queda dele
compõe com a nossa.

**Deixar o usuário travar 1080p60 de verdade.** Ele já pode escolher, e a
escolha é respeitada como intenção — mas o orçamento continua valendo. Obedecer
o rótulo contra a medição devolveria a imagem borrada com o produto afirmando
que está tudo bem.

**Baixar o teto de espectadores para 3.** Foi proposto e recusado pelo dono do
produto: cinco continua sendo o teto. A consequência está declarada acima.

## O que continua sem verificação

Nada aqui foi medido em hardware real. Falta, com o mesmo jogo e o mesmo link:

1. `chrome://webrtc-internals` no transmissor — confirmar que `frameWidth`
   acompanha o degrau e que `qp_sum / framesEncoded` caiu;
2. comparar a foto antes e depois com dois e com cinco espectadores;
3. confirmar que a linha "densidade" fica acima de 0,10 nos dois casos.
