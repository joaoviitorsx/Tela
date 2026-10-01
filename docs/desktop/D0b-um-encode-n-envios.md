# D0b — "Um encode, N envios" dentro do Chromium

**Data:** 2026-10-01 · **Máquina:** a do `D0-relatorio-linux.md` · **Harness:**
`apps/desktop/d0/injecao.mjs` + `injecao-worker.js`

## Problema

O D0 mostrou que o Chromium codifica **uma vez por espectador**: com 3 amigos,
o vídeo é codificado 3 vezes. A literatura confirma — o WebRTC encoda por
`PeerConnection` porque cada encoder se adapta à banda do seu caminho, e
compartilhar exige uma *encoder factory* própria, inacessível do JavaScript
([discuss-webrtc](https://groups.google.com/g/discuss-webrtc/c/SZAngREoysk),
[mediamtx#4351](https://github.com/bluenviron/mediamtx/issues/4351)). A R5
parte da premissa contrária.

## O que existe no Chromium 152 (Electron 44), sondado em runtime

| API | Estado |
|---|---|
| `RTCRtpScriptTransform` (Encoded Transform) | disponível |
| `new RTCEncodedVideoFrame(frame, options)` | disponível |
| `RTCEncodedVideoFrame.setMetadata` | atrás de `RTCEncodedFrameSetMetadata` (o Electron liga por `enableBlinkFeatures`) |
| `createEncodedSource` / Encoded Source | **ausente** — está em *Intent to Prototype* ([blink-dev](http://www.mail-archive.com/blink-dev@chromium.org/msg17367.html)); é a API certa para isto quando sair |
| `VideoEncoder` (WebCodecs), `MediaStreamTrackProcessor` | disponíveis |

O spec de Encoded Transform proíbe mover quadros entre senders
([w3c](https://w3c.github.io/webrtc-encoded-transform/)) — mas o `data` do
quadro é gravável. Então cada sender reescreve **os próprios** quadros.

## Como funciona

```text
captura ─► MediaStreamTrackProcessor ─► VideoEncoder (UM, 1080p60) ─► chunks ─┐
                                                                           │ MessagePort
isca 160×90 ─► sender A (encoda a isca, barato) ─► transform ─ troca data ◄┤
isca 160×90 ─► sender B ───────────────────────► transform ─ troca data ◄─┤
isca 160×90 ─► sender C ───────────────────────► transform ─ troca data ◄─┘
```

- Quadro-isca sem quadro real novo é descartado (o spec permite descartar).
- Quem entra ou pede quadro-chave só recebe a partir de um IDR na ponta.
- Chave gerada pela isca = PLI do espectador → IDR no encoder único (no máximo
  um a cada 500 ms).
- Contrapressão: com fila de 2+ quadros num sender vivo, o encoder pula um
  quadro de conteúdo em vez de acumular latência.

## Resultado

O espectador é a rota `/<canal>` **de produção**, sem nenhuma mudança: recebe e
decodifica 1920×1080.

| | Caminho normal | Um encode, N envios |
|---|---|---|
| CPU do transmissor, 1 espectador, 1080p60 | ~1,2 núcleo | 1,20 |
| CPU do transmissor, 3 espectadores, 1080p60 | ~3,6 (3 × 1,2) | **1,57** |
| Custo por espectador a mais | ~1,2 | **~0,2** (isca + empacotamento + SRTP + cópia) |
| Fila extra de conteúdo | — | 0–1 quadro |
| Decodificado no espectador | 54 fps (720p, controle) | 54 fps em 1080p (2 de 3; o 3º reconectou uma vez) |

## Virou produto (2026-10-01)

O protótipo foi para o código do app como peças próprias, com a
`BroadcastSession` e as malhas intactas:

| Peça | Onde | O que faz |
|---|---|---|
| `alvoDoCodificador` | `core/media/alvo-do-codificador.ts` (puro, testado) | Resolução, fps e bitrate do encoder único com a regra da topologia (nominal sem medição; orçamento até o teto útil), mais um freio pela pior estimativa medida — que vira `bandwidth` para a malha descer o degrau |
| `FilaDeInjecao` | `core/media/fila-de-injecao.ts` (puro, testado) | Qual quadro real vai em cada vaga de isca: IDR na ponta para quem entra, ordem sem buracos, sender morto fora do atraso |
| Worker | `adapters/injecao-worker.ts` | Liga a fila ao Encoded Transform |
| `CodificadorWebCodecs` | `adapters/webcodecs-codificador.ts` | Encoder único, contrapressão, IDR limitado a um por 500 ms |
| `makeEncodeOnceTransport` | `adapters/encode-once-transport.ts` | Embrulha o mesh: isca com parâmetros fixos, degrau/orçamento/prioridade no encoder, estatísticas com bytes reais dos senders e tamanho do encoder |
| E2E | `e2e/um-encode.e2e.mjs` | Chrome real, espectadores de produção, critérios automáticos |

### Os três defeitos que a medição achou no caminho

1. **A isca gerava quadro-chave sozinha** (~3/s): clone da captura, ela levava
   o movimento do jogo e a detecção de troca de cena do encoder inseria IDR.
   Cada um virava IDR no encoder único — 112 em 60 s, espectador a 20 fps com
   103 congelamentos. A isca agora é um canvas estático que emite um quadro por
   quadro capturado: **2 quadros-chave em toda a transmissão**.
2. **Fila presa atrás** (~280 ms a mais): quem entrava começava num IDR antigo.
   Agora só num IDR na ponta.
3. **Trava da contrapressão** por sender morto contando atraso: senders sem
   vaga há 1 s saem da conta.

`VideoEncoder.configure()` só com bitrate novo **não** gera quadro-chave
(conferido), então o freio rápido pode ajustar o bitrate a cada segundo.

### Resultado com a sessão real (malhas, governador), 3 espectadores

| | |
|---|---|
| Degrau alcançado | p1080p60, 0,13 bpp (o caminho normal ficava em 720p no mesmo loopback) |
| Recebido | 1920×1080 a 54 fps nos três, 0–1 congelamento |
| CPU do transmissor | 1,62 núcleo (encode em software, Linux NVIDIA) |
| E2E headless (2 espectadores, fonte 30 fps) | 30 fps decodificados, 0 quadro-chave em 30 s, sem reconexão |

## O que falta (atualizado)

- Ligar o transporte novo no app (D1): hoje só os harnesses o usam.
- Linux NVIDIA continua em software (~1,2 núcleo a 1080p60, agora constante
  com N): addon NVENC (D0c).
- A reconexão ocasional vista no protótipo não reapareceu depois das três
  correções; seguir observando nas rodadas longas.

## O que faltava para virar produto (registro do protótipo)

1. **IDRs demais (22 em 75 s).** Toda reconfiguração da isca (`setParameters`
   ao entrar espectador, troca de degrau) gera chave na isca, tratada como PLI.
   Distinguir PLI de reconfiguração (`getMetadata`, contadores de PLI do
   `outbound-rtp`) e manter a isca com parâmetros fixos.
2. **Reconexão ocasional** de um espectador: rastrear o motivo no diário do
   `ViewerSession` (vigia de mídia/latência).
3. **Malhas:** hoje elas mexem em `scaleResolutionDownBy`/`maxBitrate` do
   sender. Com injeção, o degrau e o bitrate passam a ser do `VideoEncoder`
   (`configure` com nova resolução/bitrate); a estimativa de banda por
   caminho (`availableOutgoingBitrate`) continua vindo dos senders. A
   adaptação coletiva da R5 fica até mais simples: há um encoder só.
4. **Áudio** não muda (Opus por sender, barato).
5. **Encoder trocável:** o mesmo ponto de injeção aceita chunks de outra fonte.
   Windows: `VideoEncoder` com `prefer-hardware` (Media Foundation). Linux
   NVIDIA: um addon NVENC (o driver traz `libnvidia-encode`) produzindo H.264
   Annex B no mesmo formato — sem trocar o transporte.
6. **Encoded Source:** quando o Chromium publicar `createEncodedSource`, a isca
   e a troca de bytes saem; o resto fica.

## Leitura

O ×N do custo — a parte do problema que vale nas duas plataformas — tem saída
dentro do Chromium, sem servidor de mídia e sem mudar o espectador. O
encode em software no Linux NVIDIA continua (1,2 núcleo a 1080p60, agora
constante com N); o addon NVENC é o passo seguinte para ele.
