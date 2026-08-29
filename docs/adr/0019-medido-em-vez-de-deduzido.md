# ADR 0019 — Medido, em vez de deduzido

**Data:** 2026-08-29
**Estado:** aceita
**Corrige:** ADR 0018 (uma regressão catastrófica) · **Recalibra:** ADR 0010, 0016, 0017

## Contexto

As ADRs 0015 a 0018 saíram todas no mesmo dia, sem uma única medição. Esta
saiu de três verificações reais, feitas em paralelo:

1. **Simulador** (`e2e/malhas.sim.mjs`) — 1200 cenários × 300s exercitando as
   classes REAIS, com o teto `1,5 × acked` do `AimdRateControl` modelado.
2. **E2E em browser** (`e2e/qualidade.e2e.mjs`) — dois Chrome for Testing 151
   com `RTCPeerConnection`, SDP, ICE e encoder H.264 de verdade.
3. **Levantamento de referências** — números publicados de OBS, Discord,
   Twitch, YouTube Live, Zoom, Meet, libwebrtc, LiveKit, Jitsi, mediasoup.

---

## A regressão que a ADR 0018 introduziu

`seed()` passou a preencher `aplicado` para que a primeira leitura tivesse de
vencer a histerese. Isso criou uma **banda morta**: com a semente certa, a
medição real cai dentro de `[−30%, +6%]`, `observe()` devolve `null`,
`setUplinkBudget` nunca é chamado, e a topologia fica sem orçamento — usando
`tetoUtil` para todo mundo. E como `estimativa` já é não-nula, a escada de
pressão também se cala. **As duas malhas mudas ao mesmo tempo.**

| semente | mudos em 300s | 1º orçamento (mediana) |
|---|---|---|
| ausente | 0 / 306 | 11 s |
| **correta** | **101 / 306** | **115 s** |

Pior caso: link de 5 Mbps, 5 espectadores, 300 segundos pedindo 24,88 Mbps.
**0,0068 bit por pixel** — quinze vezes abaixo do piso. Zero reconfigurações,
`motivoDegradacao: null`.

A forma em campo é cruel: **a primeira transmissão funciona, a segunda não** —
porque a primeira é que grava a semente.

**Correção:** `seed()` mantém só o aquecimento. A média móvel parte do valor
lembrado e converge em oito amostras (o peso da semente decai para 10%), e
`aplicado === null` garante que a primeira decisão depois do aquecimento sempre
emite.

---

## A catraca continuava fechada para N ≥ 2

A aritmética da ADR 0018 foi feita para um peer. Com o mínimo entre peers
(correto pela R5) e ruído de ±20%, `E[min de N]` vale `0,8 + 0,4/(N+1)` da
capacidade real — um viés que cresce com N:

```
alvo/aplicado = 1,125 × (0,8 + 0,4/(N+1))
  N=1 → 1,125  sobe          N=3 → 1,013  trava
  N=2 → 1,050  trava         N=5 → 0,975  trava     (limiar 1,06)
```

Link de 300 Mbps com cinco espectadores: **uma reconfiguração no segundo 11 e
congelado nos 289 seguintes a 52% do que o link pagava.**

**Correção:** o governador guarda uma média móvel **por peer** e tira o mínimo
das suavizadas, em vez de suavizar o mínimo das ruidosas. Mínimo de suavizados
≠ suavizado do mínimo: o viés desaparece e a razão volta a 1,125 para qualquer
N. Peer que sai é removido do mapa.

Isso exigiu que a identidade do peer atravessasse o pipeline: `collectStats`
passou a devolver `{ peerId, report }`, e o `StatsSampler` passou a chavear por
`peerId` em vez do índice do array — índice não é identidade, e quando um peer
sai todos os seguintes deslizam.

---

## As malhas cortavam com base na própria atuação

Dois casos medidos em que a leitura baixa não fala sobre a rede:

**O degrau caiu por CPU.** O teto do sender vira `BPP_TETO × pixels` do degrau
novo, `acked` cai junto, e o governador registra isso como "o link encolheu".
Medido: link de 800 Mbps terminando 300s em **28% da capacidade**, com
recuperação projetada para t ≈ 460s — cinco minutos depois de a CPU liberar.

**A cena está parada.** O encoder não consome o alvo, `acked` desaba, e o teto
de `1,5 × acked` desce junto sem a rede ter mudado nada.

**Correção:** `observe()` aceita `permitirQueda: false`. A sessão desliga a
queda quando o teto de pixel é o limitador ativo, ou quando o encoder está
enviando menos de 70% do orçamento. Subir continua sempre permitido — leitura
alta é notícia verdadeira em qualquer regime.

---

## O que o mercado diz, e onde eu tinha inventado

**`BPP_TETO = 0,20` não tinha precedente nenhum.** Em OBS, Twitch, YouTube
Live, Discord, Zoom, Meet, libwebrtc, LiveKit, Jitsi, mediasoup e Janus, o
maior bits-por-pixel publicado para 1080p60 é o do **Zoom, com 0,103** — e o
Zoom é o comparável mais justo que existe, também tempo real e também um passe.
Eu estava autorizando 1,94× o teto do mercado, ao custo de 124 Mbps de subida
com cinco espectadores.

**Novo valor: 0,13.** Fica 1,29× acima do YouTube Live e 1,21× acima do Zoom —
margem que paga o prêmio de tempo real e de movimento de gameplay sem gastar
banda que ninguém demonstrou virar imagem. Em 1080p60 são 16,2 Mbps.

**Os 12 Mbps de `p1080p60`, por outro lado, estão exatos** — batem com a
recomendação H.264 do YouTube Live para 1080p60. E o "OBS usa 5,8 Mbps como
mínimo" da ADR 0010 é literal no código deles:
`areaVal = pow((cx*cy), 0.85l)`, ancorado em `1920x1080@60 == 5800`.

**`nitidez` se creditava banda que não existe.** `presetForBitrate(bps, 30)`
assumia que 30fps custa metade de 60fps. Nenhuma tabela concorda: OBS usa
`fps^0.55` (1,46× para dobrar), YouTube 1,20–1,50×, Twitch 1,33–1,50×. A
mediana é ~1,5×, não 2,0× — o modo escolhia um degrau alto demais para o
orçamento, o oposto do que promete. Agora usa `custoDeFramerate` com o expoente
0,55 do OBS.

**Existiam duas folgas divergentes.** `uplinkHeadroom = 0,7` na sugestão e
`UPLINK_SHARE = 0,75` em regime: o produto sugeria com um número e operava com
outro. Uma só, e é a do governador.

**`p2pViewerBudget` subestimava o custo em até 2×**, contando o nominal do
degrau quando a topologia gasta `min(orçamento, BPP_TETO × pixels)`.

---

## O áudio estava em mono

Capturamos em estéreo (`channelCount: 2`, com os três processamentos de voz
desligados) e pagamos 128 kbps por espectador. Mas o Chromium negocia mono a
menos que o `fmtp` peça:

```cpp
inline constexpr int kOpusDefaultStereo = 0;
int GetChannelCount(format) { return param == "1" ? 2 : 1; }
```

E o `afinarSdp` só tocava em `m=video`. Os 128 kbps compravam **um canal só**.
Agora ele injeta `stereo=1;sprop-stereo=1`. Custo: **zero bit a mais** — o
bitrate já estava pago.

---

## Passamos a medir QP, que é a variável de verdade

Todo o `BPP_PISO` existe como *proxy* para "o QP fica abaixo de 37", e a ADR
0010 admite que os 0,10 vieram de literatura e não de medição. O limiar é
público, na implementação que enfrentamos:

```cpp
const int kLowH264QpThreshold  = 24;
const int kHighH264QpThreshold = 37;   // h264_encoder_impl.cc, escala 0–51
```

`qpSum / framesEncoded` já vinha no `getStats()` que coletamos por segundo. O
console mostra os dois agora — bpp e QP — e alerta quando qualquer um passa do
limiar.

---

## O que o E2E em browser real PROVOU

Chrome for Testing 151, dois contextos, H.264 real, canvas 1920×1080 com
movimento de tela cheia.

| Verificação | Resultado |
|---|---|
| `scaleResolutionDownBy` tira pixel | **Sim.** `frameWidth = 1920 / scale` exato nos seis degraus |
| Munging de SDP chega e AGE | **Sim.** Com `x-google-start-bitrate`: estimativa inicial de **12,0 Mbps** e arranque em **1920×1080**. Sem ele: **0,3 Mbps** e **480×270** |
| Nível elevado para 4.2 | **Sim.** `4d002a` na descrição aplicada |
| A malha do orçamento abre | **Sim.** 30,9 → 45,2 Mbps em 7 passos, sem catraca |
| bpp abaixo de 0,10 | **Nunca**, em 340 amostras. Mínimo 0,197 |
| Parâmetros idênticos entre peers (R5) | **Sim**, com 2 e com 3 espectadores, inclusive após troca ao vivo |

Duas coisas que o browser desmentiu:

**High profile não existe neste Chromium.** Só `42` (Baseline) e `4d` (Main)
são oferecidos. `ordenarH264` funcionou — negociou Main em vez de Baseline —
mas o ganho de CABAC que a ADR 0016 promete não pôde ser medido.

**`encoderImplementation` não existe no caminho do produto.** O campo só
aparece enquanto há captura de câmera ou microfone VIVA; numa página que só
captura tela, a chave nem está no relatório. O indicador "hardware/software" do
console lê `null` em produção. Fica registrado como não-resolvido.

---

## Duas correções tentadas e REJEITADAS

**Sondagem acima do teto útil.** A escada tem uma catraca residual: para subir
de 360p60 para 480p60 é preciso que a estimativa alcance 1,216× o teto útil,
mas o ALR só permite 1,125×. Gastar 25% acima do teto enquanto degradado
resolveu — zerou os 66 estados absorventes — e **decuplicou o sobreuso do
link**, de 44 para 478 cenários. Num produto cujo requisito central é não
estrangular o ping do jogo, é a troca errada. O browser real, além disso,
mostrou a malha abrindo sem sondagem nenhuma.

**Realimentar a resolução medida no teto.** O E2E mostrou que pagamos 10–12
Mbps por quadros de 640×360 quando o *quality scaler* do Chromium encolhe por
cima da nossa escala — dez vezes o teto útil, desperdício real. Mas realimentar
a saída do encoder no teto DELE é uma espiral: teto menor → o scaler encolhe
mais → teto menor ainda. Medido: os cenários abaixo do piso saltaram de 56 para
**570**. A medida continua sendo usada onde não realimenta nada — o bpp exibido
no console vem de `frameWidth`/`frameHeight` reais.

---

## Resultado

Mesmos 1200 cenários, antes e depois da revisão inteira:

| | antes | depois |
|---|---|---|
| bpp entregue < 0,10 | 196 | **56** |
| rótulo mente sobre o bpp | 131 | **6** |
| governador nunca emitiu | 160 | **0** |
| 1º orçamento (p90) | 300 s | **11 s** |
| pedindo mais que o link | 302 | **44** |
| malha instável | 788 | 576 |
| qualidade < 80% do link | 226 | 201 |
| estados absorventes | 19 | 66 |

Os absorventes subiram, e em parte é artefato: 160 cenários que antes eram
**mudos** agora funcionam, e um cenário mudo não conta como "desceu e nunca
voltou". A parte real é a catraca da escada descrita acima, cuja única correção
conhecida custa sobreuso.

Dos 56 quadriculados restantes, a maioria é física: 5 Mbps de upload com cinco
espectadores dão 1 Mbps por espectador, e o último degrau da escada precisa de
1,38. Abaixo disso não existe vídeo de 60fps para entregar.

---

## O que continua sem verificação

1. **Encode e decode em hardware.** O E2E só teve OpenH264 em software
   (`powerEfficientEncoder: false`, 19–21 ms/quadro a 1080p — acima dos 16,7 ms
   que 60fps exige). Com ele cai todo o valor medido da elevação de nível para
   4.2 e do próprio argumento "H.264 porque tem HW em qualquer GPU".
2. **High profile**, que este Chromium não oferece.
3. **Rede de verdade.** O loopback tem RTT de 0–1 ms e zero perda: nada de
   bufferbloat, TURN, espectador em ADSL ou celular.
4. **`getDisplayMedia` e o `displaySurface: 'monitor'`**, porque o seletor é do
   sistema operacional. A correção é observável em um clique por um humano.
5. **O estéreo do Opus** chegando de fato no espectador.
6. **`encoderImplementation`** — como reportar encode em hardware sem depender
   de um campo que não existe no caminho de captura de tela.
7. **As premissas do simulador**, listadas com `--premissas`. A mais otimista:
   o encoder sempre consome o alvo inteiro. Cena parada derruba `acked` sem a
   rede piorar, e é o caminho mais provável para a catraca aparecer em campo.
