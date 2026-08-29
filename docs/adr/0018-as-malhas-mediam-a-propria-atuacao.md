# ADR 0018 — As malhas mediam a própria atuação

**Data:** 2026-08-29
**Estado:** aceita
**Corrige:** ADR 0017 (que prometeu 0,20 bpp e entregava 0,108)
**Origem:** revisão adversarial das quatro etapas do pipeline, feita em paralelo

## Contexto

A ADR 0017 saiu de manhã afirmando que um link com banda de sobra passaria a
receber 24,9 Mbps em 1080p60. O relato voltou no mesmo dia: **800 Mbps de
subida, imagem ainda ruim.**

Quatro revisões independentes — captura/encode, transporte, espectador, malhas
de controle — chegaram a 30 achados. Duas delas, sem se falarem, apontaram a
mesma causa raiz, e ela invalida a ADR 0017.

---

## O defeito central: a catraca de mão única

O governador compara o alvo com o valor já aplicado, e a histerese era
simétrica em 25%:

```
subir  exige  alvo ≥ 1,25 × aplicado  →  media ≥ 1,25/0,75 = 1,667 × aplicado
cortar exige  alvo ≤ 0,75 × aplicado  →  media ≤ 1,000 × aplicado
```

Só que **`aplicado` VIRA o `maxBitrate` do sender**, e `availableOutgoingBitrate`
é a leitura do controle de congestionamento *desse mesmo sender*. A grandeza
medida é limitada pela grandeza atuada.

O `AimdRateControl` do libwebrtc tampa a estimativa em
`1,5 × acked_throughput + 10 kbps`, e `acked ≈ aplicado` sempre que somos nós o
limitador — que é o regime permanente aqui.

```
media alcançável ≤ 1,500 × aplicado
media necessária ≥ 1,667 × aplicado
```

**A malha era estruturalmente incapaz de abrir.** Simulado em 420 segundos com
link de 800 Mbps: o orçamento trava em 13,5 Mbps no nono segundo e não sobe
nunca mais. Com qualquer soluço, ele *desce* e não volta — em sete minutos
chega ao piso de 300 kbps, que em 360p60 são 0,022 bpp.

E as duas constantes foram escolhidas separadamente: `HISTERESE` valia
exatamente `1 − UPLINK_SHARE`, o que deixa o sistema **encostado na borda do
corte** em regime permanente. Depois de 20 segundos estáveis, uma leitura 0,32%
abaixo do orçamento dispara um corte de 25% irreversível.

O teste que "provava" a ADR 0017 chamava `setOrcamento(300_000_000)` **direto**,
pulando o governador. Por isso passou.

### Decisão

**Histerese assimétrica, calibrada pelo teto do estimador.** O teto de 1,5
limita a razão `alvo/aplicado` a `0,75 × 1,5 = 1,125` por ciclo — qualquer banda
de subida acima de 12,5% trava. `SUBIR = 0,06` deixa margem e ainda exige
`media ≥ 1,413 × aplicado`, bem acima do ruído. `CORTAR = 0,30` acaba com a
catraca.

**E o arranque deixa de estrangular a medição.** Sem orçamento, o teto do sender
passa a ser o ÚTIL (0,20 bpp) em vez do nominal do preset. Parecia prudente
limitar em 12 Mbps até medir; era o contrário — **um `maxBitrate` nunca causa
afogamento sozinho**, porque o alocador do WebRTC entrega ao encoder
`min(BWE, maxBitrate)` e o BWE é delay-based. O teto protege contra o BWE
superestimar; ele não empurra nada. O que ele fazia, sendo baixo, era cegar o
estimador.

Quem empurra é o bitrate INICIAL, e esse continua conservador:
`x-google-start-bitrate` usa o nominal enquanto não há medição.

---

## O mesmo fio, em mais quatro lugares

**A semente desligava as duas defesas.** `seed()` punha
`amostras = AQUECIMENTO + 1` e deixava `aplicado` nulo, então a primeira leitura
caía no ramo "sem valor anterior", que aplica sem histerese e com o aquecimento
já vencido. A semente, que existe para evitar oito segundos cegos, removia
aquecimento *e* histerese da decisão mais importante da sessão. E ela é a mais
importante de verdade: um espectador que entra enquanto a captura ainda está nos
5fps do modo ocioso produz uma leitura de ~2 Mbps, e era esse número que fixava
o orçamento da transmissão inteira. Agora `seed()` preenche `aplicado` e mantém
o aquecimento.

**O orçamento por espectador era a MÉDIA, não o MÍNIMO.** Pela R5 todos os
senders recebem o mesmo `maxBitrate`, então o que cabe é o que o pior caminho
aguenta. Somar e dividir por N deixava um amigo em ADSL de 5 Mbps recebendo
24 Mbps porque o outro estava em fibra: ~80% de perda contínua para ele,
quadriculado permanente, e o transmissor sem ver nada porque o HUD mostra a
soma. A própria ADR 0017 declarava a intenção certa — "um espectador com 20 Mbps
de descida puxa todo mundo para baixo, e isso é por projeto" — e o código fazia
o oposto.

**O divisor contava quem ainda não tinha medido.** `availableBps` só soma pares
ICE nominados; `peers.length` conta também quem está em `connecting`. Numerador
e denominador fora de fase: cinco amigos clicando juntos num "vem ver"
subestimavam o orçamento em até 5× no pior instante — e pela catraca, a
transmissão morava lá.

**A calmaria zerava a cada blip.** Descer exige 5 amostras consecutivas; subir
exigia 60 CONSECUTIVAS, e qualquer leitura de aperto zerava o contador. Um
`qualityLimitationReason: 'cpu'` isolado é rotina: keyframe, troca de cena,
alt-tab. Com 10% de leituras assim, o tempo médio para recuperar UM degrau ia de
60 segundos para 92 minutos; com 20%, nunca. O comentário dizia "doze vezes mais
lento que a descida" — com ruído real eram duas a três ordens de grandeza.
Agora a calmaria decai 5 em vez de zerar, o que mantém o saldo positivo até
p ≈ 17%.

---

## A escada não era monótona: mais banda dava imagem PIOR

`presetForBitrate` escolhia pelo `maxBitrate` **nominal** do degrau, e três
degraus da tabela têm nominal abaixo do piso — 1080p60 a 0,0965, 900p60 a
0,0926, 720p60 a 0,0995.

| orçamento | degrau | bpp |
|---|---|---|
| 7,75 Mbps | p720p60 | **0,140** |
| **8,00 Mbps** | p900p60 | **0,093** |
| 11,75 Mbps | p900p60 | 0,136 |
| **12,00 Mbps** | p1080p60 | **0,097** |

3% a mais de banda derrubava 34% da densidade. As faixas venenosas eram
8,00–8,64 e 12,00–12,44 Mbps por espectador — um link de 23 Mbps com dois
espectadores cai exatamente na primeira. E abaixo de 0,10 o quality scaler do
Chromium começa a derrubar resolução por conta própria, compondo com a nossa: o
mecanismo da ADR 0015, reintroduzido pela fronteira.

`BPP_PISO` existia como constante e **nunca era executado em lugar nenhum do
runtime** — só em comentário. Pior: o teste que pegaria isso foi afrouxado para
`>= 0,09` no dia anterior, com um comentário admitindo a folga. Ajustou-se o
teste ao código em vez do código à regra.

**Decisão:** o critério passa a ser `orçamento ≥ BPP_PISO × w × h × fps`. Há um
teste varrendo 1,5 a 30 Mbps em passos de 50 kbps exigindo monotonicidade.

---

## Uma linha de captura que não fazia nada

`displaySurface: 'monitor'` estava no nível de cima do
`DisplayMediaStreamOptions` — dicionário que tem **só** `audio` e `video`.
`displaySurface` é constraint (`MediaTrackConstraintSet`), então o lugar dele é
dentro de `video`. Membro desconhecido é descartado em silêncio, e o
`as DisplayMediaStreamOptions` do adapter era exatamente o que impedia o
TypeScript de acusar.

O seletor nunca abriu em "Tela inteira". A cascata: o usuário caía na aba
"Janela", compartilhava o jogo em 1280×720, `escalaPara` via `1280 ≤ 1920` e
devolvia 1, e todo o orçamento continuava sendo calculado em cima de 1920×1080 —
teto útil de 24,9 Mbps para um quadro de 0,92 Mpx, 0,45 bpp real. O espectador
recebia **720p esticado** com a UI escrita `1080p60`. No Windows, sem tela
inteira também não vem áudio do sistema, que é o outro motivo pelo qual a linha
existe.

Nenhum teste podia pegar isso olhando o resultado — a captura funciona, só abre
na aba errada. Só olhando o que foi PEDIDO, que é o que
`browser-screen-capture.test.ts` passa a fazer.

---

## O espectador: a UI jogava fora o que o transporte absorvia

**Toda oscilação de rede destruía o `<video>`.** A rota fazia early-return da
tela de espera para qualquer status ≠ `watching`, e `reconnecting` é um desses.
O transporte emite `reconnecting` em dois gatilhos baratíssimos — `track.onmute`
e `connectionState === 'disconnected'` — e nenhum significa que a mídia parou:
uma troca de AP no Wi-Fi falha os consent checks do ICE por alguns segundos com
o mesmo par de candidatos entregando pacotes o tempo todo.

Nesses segundos o produto arrancava um vídeo que nunca parou, mostrava um cartão
em tela cheia, e depois montava um `<video>` **novo**, preto até o próximo
quadro. É a "travadinha" dos relatos, e é o oposto exato do que os 80ms de
jitter buffer da ADR 0016 compram. O estado `reconnecting` passa a carregar o
stream, e a imagem fica.

**A tela cheia era inalcançável no iPhone.** `document.fullscreenElement !== null`
— e no iPhone a propriedade é `undefined`, então `undefined !== null` é
**`true`**: o código entrava no ramo de SAÍDA e chamava `document.exitFullscreen()`,
que também não existe. `TypeError` síncrono dentro do `onClick`, que o `.catch()`
não pega porque nada chegou a ser retornado. O fallback `webkitEnterFullscreen`,
que existe justamente para o iPhone, nunca era alcançado.

Consequência: 1080p espremido em ~390px de largura. Redução de 4,9× — "imagem
borrada" no celular que não tem nada a ver com encoder.

**`h-screen` empurrava o HUD para fora da dobra.** `100vh` é a viewport grande no
celular, com a barra de URL recolhida. `OfflineState` já usava `min-h-dvh` com um
comentário explicando exatamente essa armadilha; o `Viewer` tinha ficado de fora.

**O diagnóstico mentia nos dois sentidos.** `encoderImplementation` era lido
também no caminho `inbound`, onde o campo se chama `decoderImplementation` e o
primeiro nunca existe — o espectador jamais soube se decodificava em hardware. E
a detecção era uma lista de permissão de nomes de hardware com fallback para
"software": o MediaCodec do Android (`OMX.qcom.video.encoder.avc`) não casava com
nada e era acusado de software, **com alerta**; já
`SimulcastEncoderAdapter (ExternalEncoder, libvpx, libvpx)` casava "external" e
passava por hardware puro. Agora a lista fechada é a de *software*, e o que não
se reconhece vira `desconhecido` em vez de uma acusação.

---

## Transporte: seis caminhos para divergência de parâmetros

Divergência entre peers faz o Chrome parar de reaproveitar o encoder, e viram N
encoders 1080p60 disputando a GPU com o jogo — o cenário que a R5 existe para
impedir.

1. **O retry de `setParameters` reusava um `params` já consumido.** O Blink limpa
   `last_returned_parameters_` ao ENTRAR em `setParameters`, então a segunda
   chamada rejeitava com `InvalidStateError` antes de olhar o conteúdo: o
   fallback escrito para "salvar o essencial" não salvava nada. E ele omitia o
   `degradationPreference` de propósito, tratando a perda como sucesso parcial.
2. **`tentativasAnteriores` era um contador vitalício.** Incrementado em
   `marcarPendente`, nunca apagado no sucesso. Três rejeições transitórias
   espalhadas por duas horas e aquele sender saía da fila para sempre.
3. **`getParameters()` estava fora de qualquer `try`, dentro de um `for`.** Um
   throw no primeiro sender descartava os seguintes — e como a fila é esvaziada
   *antes* do lote, eles nunca mais voltavam. Pior: a rejeição subia e, no
   caminho `publish` → `publishVideo`, virava `fail('TRANSPORT_FAILED')`, matando
   a transmissão inteira porque um peer que já saía lançou.
4. **`drop()` e `close()` vazavam as duas filas**, segurando `RTCPeerConnection`
   fechadas vivas e fazendo `collectStats` reconfigurar senders mortos todo
   segundo.
5. **`attach()` aplicava o preset FORA da fila**, em paralelo com o `adaptAll` de
   `publish`. Convergiam por acidente — não há `await` entre `getParameters` e
   `setParameters` — e a primeira edição que pusesse um traria de volta o
   `InvalidStateError` da ADR 0006 A3.
6. **A escala era registrada antes da confirmação.** Se todos os `setParameters`
   falhassem, `escalaAplicada` afirmava que a escala estava no ar e
   `escalaMudou()` passava a devolver `false`, desligando a rede de segurança
   que ela é.

**Mais três, fora desse tema:**

**`escalaPara` só olhava a largura.** Numa tela 16:10 — 1920×1200, comuníssima em
notebook — `1920 ≤ 1920` devolvia escala 1, e o encoder recebia 11% mais pixel do
que o orçamento pagou. Agora é o maior dos dois fatores.

**Um candidato ICE ruim derrubava o espectador.** A regra era "candidato de
oferta ignorada é lixo esperado; qualquer outra falha deve subir" — mas "subir"
aqui não é um log: a topologia faz `drop(peerId)` e o espectador recebe
`NEGOTIATION_FAILED`. Um `sdpMid` de seção que o `max-bundle` derrubou matava a
sessão. A assimetria de custo decide: perder um candidato degrada o ICE, há
outros.

**Duas coletas de `getStats()` por peer por segundo, em série.** `collectStats`
fazia uma e `refreshRelayStatus` fazia outra. Com cinco espectadores, dez
chamadas sequenciais por segundo, na máquina que está com o jogo aberto. E o
`announce()` era incondicional, forçando re-render do React uma vez por segundo
sem nada ter mudado.

---

## Consequências

**O caminho da ADR 0017 finalmente existe.** Simulado: link de 800 Mbps atinge
24,88 Mbps (0,200 bpp) e fica lá. Antes travava em 13,5 Mbps e apodrecia.

**Consumo maior onde há banda, honesto onde não há.** O mínimo entre peers
significa que um amigo em ADSL segura todo mundo — é o que a R5 sempre disse, e
agora é o que o código faz.

**Um fake que mentia parou de mentir.** `FakeScreenCapture` devolvia sempre a
mesma trilha, o que tornava o vazamento de áudio de `switchSource` invisível. E
`fakeTrack` não tinha `getSettings`, então `escalaPara` devolvia 1 em todos os
testes — foi assim que um `scaleResolutionDownBy` sobrescrito por um spread
passou despercebido. Fake que não modela a coisa certa não testa nada.

---

## O fio que liga quase tudo

Sete dos trinta achados são a mesma doença: **as malhas mediam a própria
atuação.** `availableOutgoingBitrate` é limitado pelo `maxBitrate` que gravamos;
o teto útil é limitado pelo degrau que escolhemos; a taxa reconhecida é limitada
pelo framerate de captura que impomos. Nenhuma dessas malhas tinha referência
independente do link, e por isso todas confundiam "eu apertei" com "o link
encolheu".

O resto é a outra metade da mesma moeda: **o que não é medido não existe.** Uma
linha de constraint no lugar errado, um campo de stats do sentido oposto, um
`BPP_PISO` que só vivia em comentário, um teste afrouxado para caber no código.
Nada disso aparece em teste verde — e a suíte estava verde nos 275 testes o
tempo todo.

---

## O que continua sem verificação

1. O teto de `1,5 × acked` do `AimdRateControl` foi lido do libwebrtc, não
   medido neste produto. Confirmar em `chrome://webrtc-internals` que
   `availableOutgoingBitrate` de fato sobe depois da mudança.
2. Que o orçamento chega perto de 24,9 Mbps no link de 800 Mbps, e que a linha
   **densidade** do console marca ~0,20.
3. Que o seletor agora abre em "Tela inteira" — é observável em um clique.
4. Que a tela cheia funciona no iPhone, e que o HUD do espectador aparece no
   celular.
5. Que o `<video>` não pisca mais numa troca de rede do espectador.
6. Se `maxFramerate: 30` é honrado pelo encoder em uso. `nitidez` troca o
   `contentHint` para `detail`, que desliga o quality scaler do Chromium — se o
   framerate não pegar, ficam 0,054 bpp sem nenhuma malha autorizada a tirar
   pixel. Vale medir `stats.fps` contra 30 e cair de degrau se divergir.
