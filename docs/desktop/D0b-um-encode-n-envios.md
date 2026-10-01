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

## O que falta para virar produto

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
