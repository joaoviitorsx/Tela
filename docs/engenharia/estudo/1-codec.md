# Estudo 1 — A camada de codificador e codec

**Data:** 2026-10-02 · **Escopo:** o codificador único do "um encode, N envios" (ADR 0029, D0b), em duas implementações: WebCodecs (`apps/web/src/adapters/webcodecs-codificador.ts`) e NVENC nativo (`apps/desktop/nativo/linux/tela-captura.c`, GStreamer `nvh264enc`).
**Regra do estudo:** nada aqui altera código do produto. O que foi medido está em `e2e/bench/estudo-*.mjs`; o que é teoria ou fonte secundária está marcado.

---

## 0. Resumo

Cinco conclusões que mudam a ordem de trabalho:

1. **Intra refresh não resolve o IDR do Tela, e a medição mostra por quê.** O WebRTC do Chromium só começa a decodificar num NAL IDR (tipo 5): o depacketizador H.264 marca `kVideoFrameKey` apenas para IDR, e o localizador de referências guarda (`kStash`) qualquer quadro até existir um quadro-chave. O NVENC emite *recovery point SEI* com `recovery_frame_cnt = g−1` (medido: 59, 29, 14), e o Chromium só trata SEI como quadro-chave quando `recovery_frame_cnt == 0`. Intra refresh reduz o **pico** em 29–58% (66 → 31 KB a 12 Mbps), mas quem entra, ou perde pacote que o NACK não recupera, continua precisando de IDR. Prioridade baixa. O que sobra de valor é **encolher o IDR** (§1.6).
2. **O maior ganho barato é o controle de taxa em tela parada.** Com NVENC em CBR, uma tela quase parada gasta o orçamento inteiro (12,00 Mbps); em VBR com o mesmo teto gasta 1,37 Mbps, com PSNR igual (43,23 vs 43,24 dB). Com 50 espectadores são ~600 Mbps contra ~68 Mbps. O código de hoje **escala o bitrate por 1/fps medido, até 2×**, de propósito (comentário em `tela-captura.c:168-178`, ADR 0018). Mexer aqui reabre a armadilha da ADR 0018 (a malha mede o próprio envio), então o ganho vem com um risco real e precisa de e2e.
3. **Camadas temporais permitem adaptação por espectador sem segundo encoder, e o descarte é bit-exato.** Medido no Chromium: derrubar T1 de um fluxo H.264 L1T2 deixa 60/60 quadros decodificados idênticos ao fluxo completo; L1T3, 30/30. Os quadros T1 têm `nal_ref_idc = 0` (não-referência), então o worker pode descartá-los por sender e voltar a enviá-los **sem IDR**. Custo: o encoder paga +14% de bits (OpenH264, pior caso) e o espectador fraco vê 30 fps. Conflita com a letra da R5 (`maintain-framerate`), então precisa de ADR; proponho a regra em §2.5.
4. **HEVC/AV1 compram de 15% a 50% de bitrate com o mesmo PSNR** (medido no NVENC AV1 desta máquina, RTX 4050; a NVIDIA publica 40% a 1080p60). Em termos do produto: a 100 Mbps de upload, de 6 para 8–10 espectadores em 1080p60 no piso da ADR 0010. Mas exige codec comum a todos os espectadores e hoje o `sender.getCapabilities` não anuncia SVC; HEVC no WebRTC do Chrome só existe com hardware. Fase 3, com a estratégia de dois níveis de §4.5.
5. **O perfil H.264 vale ~10% de bitrate (medido, NVENC): Main/High vs Constrained Baseline.** É a lacuna que a ADR 0016 deixou como "não medida". O `tela-captura.c` fixa `profile=constrained-baseline`. O risco é a SDP continuar dizendo `42e01f` enquanto os bytes são High; precisa de teste com `e2e/um-encode.e2e.mjs`.

### Tabela ranqueada

Ganhos são os medidos aqui (síntese de 1080p60, ver §6 para os limites) ou, quando dito, de fonte externa. "R5" diz se a proposta toca as quatro configurações imutáveis.

| # | Proposta | Ganho esperado | Esforço | Risco | Impacto na R5 | Prioridade |
|---|---|---|---|---|---|---|
| 1 | **Encolher o IDR**: `vbv-buffer-size` e `ldkfs` (NVENC), `bitrateMode:'constant'` não ajudou no WebCodecs sw; medir IDR real | IDR de 66–74 KB (VBV 4 q.) para 36 KB (VBV 1 q.): ~−50% de pico por IDR, −0,07 a −0,12 dB de PSNR médio (VBV 1 vs 4, medido). Mas a ADR já notou o IDR "borrado": só vale para o IDR de **reentrada**, não para o de entrada | 1 dia (propriedade GStreamer já usada) | médio: IDR borrado fica na tela até o próximo quadro bom | nenhum (não muda os 4 invariantes) | **P1** |
| 2 | **VBR com teto = orçamento da malha** em conteúdo parado, e segurar o orçamento medido | Tela parada: 12 → 1,4 Mbps (−89%) por espectador; N=50: −530 Mbps no upload | 3–5 dias + e2e malhas | **alto**: BWE cai a `1,5×acked` (ADR 0018) e a subida quando o jogo volta a mexer é lenta | toca `degradationPreference` só indiretamente; o orçamento continua do governador (ADR 0017) | **P1** (com e2e) |
| 3 | **Perfil Main/High** no NVENC e no WebCodecs (`avc1.4d002a`/`avc1.64002a`) | ~10% de bitrate a PSNR igual (NVENC, 2 conteúdos) = um degrau da escada com 12–15% de folga | 1 dia + e2e | médio: SDP anuncia `42e01f`, bytes são High; decoders de hardware de espectador | **toca a R5 item 3 só no perfil** (continua H.264); ADR 0016/0020 já tratam | **P1** |
| 4 | **Temporal drop por espectador** (L1T2) no worker | Espectador fraco: 62% dos bytes a 30 fps sem IDR nem 2º encoder; custo geral +14% de bits (OpenH264) | 1–2 semanas (NVENC exige API direta, `nvh264enc` não expõe SVC) | médio-alto: cria fps heterogêneo, relógio de congelamento do `ViewerSession` | **conflita com `maintain-framerate` e "parâmetros idênticos"**; ADR nova; opt-in | **P2** |
| 5 | **AV1 (ou HEVC) como codec comum** com fallback H.264 em nível 2 | 17–52% de bitrate a PSNR igual (AV1 NVENC); +33% a +67% de espectadores em 1080p60 por Mbps de upload | semanas; fase 3 | alto: matriz de decoders, dois encodes | **toca a R5 item 3 (`videoCodec: h264`)**: ADR obrigatória | **P3** |
| 6 | **Intra refresh periódico** | Pico do quadro grande −29% a −58%; **não** elimina IDR de entrada nem de perda no receptor libwebrtc | 1 semana (`gst` sem a propriedade; precisa de NVENC API) | alto: a promessa de "sem IDR" é falsa neste receptor | nenhum | **P4: não fazer agora** |
| 7 | **LTR / referência selecionada** | só vale se o receptor referenciar quadros de longo prazo; libwebrtc H.264 referencia o quadro anterior por número de sequência | — | — | — | **P4: não fazer** |
| 8 | Presets p1–p7, tune, multipass, AQ | ≤ 0,03 dB entre p1 e p7; multipass e AQ ≤ 0,04 dB. Em CBR de 12 Mbps o preset **não é alavanca** | 0 | — | nenhum | só reduzir custo: p1–p3 sem perda mensurável |

---

## 1. Intra refresh periódico no lugar do IDR sob demanda

### 1.1 Estado do código

- NVENC: `tela-captura.c:732` — `nvh264enc preset=p4 tune=ultra-low-latency rc-mode=cbr gop-size=-1 bframes=0 zerolatency=true repeat-sequence-header=true spatial-aq=true`, `profile=constrained-baseline`, VBV de 4 quadros (`VBV_EM_QUADROS`, linha 72). IDR só por `gst_video_event_new_upstream_force_key_unit` (linha 234).
- WebCodecs: `CodificadorWebCodecs.config()` — `avc1.42e02a`, `latencyMode:'realtime'`, `bitrateMode:'variable'`, Annex B. IDR por `encode(frame,{keyFrame:true})` com janela `janelaDeChaveMs` (500 ms, ∝ N, `complexidade.md` §C4).
- Receptor: `RTCPeerConnection` do Chromium (não WebCodecs).

### 1.2 Teoria

Intra refresh (ou *gradual decoder refresh*) espalha os macroblocos intra por várias imagens: uma "onda" de fatias intra percorre o quadro em `intraRefreshCnt` imagens, e a onda repete a cada `intraRefreshPeriod`. O guia do NVENC descreve exatamente isso e o recomenda "quando não há canal de retorno ou quando o fluxo é de GOP infinito" ([NVENC Programming Guide §8.13](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)). Também avisa o custo: `intraRefreshCnt` menor significa mais macroblocos intra por quadro e "qualidade ligeiramente menor". A cobertura é por fatias no H.264/HEVC (e por tiles no AV1), segundo o mesmo guia.

O ponto de entrada num fluxo desses é o **recovery point SEI** (payload type 6) da norma H.264: o decodificador pode começar nesse AU e só considera a imagem boa após `recovery_frame_cnt` imagens.

### 1.3 Suporte, medido e lido no código

| Camada | Estado | Fonte |
|---|---|---|
| NVENC API | `enableIntraRefresh`, `intraRefreshPeriod`, `intraRefreshCnt` (H.264/HEVC/AV1) | guia acima |
| GStreamer `nvh264enc` | **sem a propriedade** (lista de propriedades desta máquina: nenhuma `intra-refresh`) | `gst-inspect-1.0 nvh264enc` |
| FFmpeg `h264_nvenc` | `-intra-refresh 1`, período = `-g`; contagem = `g−1` | [patch FFmpeg](https://patchwork.ffmpeg.org/project/ffmpeg/patch/1630893718-16160-1-git-send-email-lance.lmwang@gmail.com/) e medição |
| WebCodecs `VideoEncoder` | **sem equivalente** (nem em `VideoEncoderConfig`, nem em `encode` options) | [W3C WebCodecs](https://www.w3.org/TR/webcodecs/) |
| WebCodecs `VideoDecoder`, chunk 'key' | aceita SEI de recovery point **só com `recovery_frame_cnt == 0`** | [`avc.cc` L370-392](https://chromium.googlesource.com/chromium/src/+/main/media/formats/mp4/avc.cc), [`video_decoder.cc` L199-206, L659-690](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webcodecs/video_decoder.cc) |
| WebRTC receptor (libwebrtc) | quadro-chave = NAL IDR. SEI não é lido | [`video_rtp_depacketizer_h264.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/rtp_rtcp/source/video_rtp_depacketizer_h264.cc) L194-196, L282-285 |
| libwebrtc, referências | sem quadro-chave: `kStash`. Quadro delta só passa se o número de sequência do pacote anterior for contíguo | [`rtp_seq_num_only_ref_finder.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/rtp_seq_num_only_ref_finder.cc) L74-76, L108-115 |
| Spec W3C (AVC) | chunk 'key' em Annex B = "IDR **e** todos os parameter sets" | [WebCodecs AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/) |

Os números de linha são da árvore `main` lida em 2026-10-02 e podem se mover. **Como decodifica quem entra num fluxo sem IDR?** No WebRTC do Chromium, não decodifica: o receptor guarda os quadros e pede PLI até chegar IDR. No WebCodecs só com `recovery_frame_cnt == 0`, que o intra refresh do NVENC não produz.

### 1.4 Medição A (NVENC real, 1080p60, CBR, VBV 4 quadros)

`node e2e/bench/estudo-intra-refresh.mjs --so=A` (`ffmpeg h264_nvenc` com os parâmetros do `tela-captura.c`. Fonte: `mandelbrot` (detalhe fino em movimento contínuo). Maior quadro ignorando o 1º quadro do fluxo; "IDR" é um IDR forçado no quadro 300.

| Mbps | Quadro médio KB | Pico com IDR forçado @1,5 s KB | Pico com intra refresh g=60 KB | g=30 KB | Redução do pico | PSNR-Y IDR → IR g=30 (clipe de 10 s) |
|---|---|---|---|---|---|---|
| 6 | 12,2 | 37,1 | 15,6 | 15,3 | −58% | n/m |
| 12 | 24,4 | **66,2** | **30,5** | 30,5 | **−54%** | 25,47 → 25,36 dB |
| 30 | 61,1 | 129,5 | 74,4 | 74,4 | −43% | 28,25 → 27,76 dB |
| 60 | 122,3 | 196,2 | 140,0 | 140,0 | −29% | n/m |

(Saída do script, clipes de 4 s. Uma execução anterior de 10 s com `ffmpeg` direto deu 74 KB de IDR e 34,8 KB de pico a 12 Mbps; a variação vem de onde o IDR cai no zoom da mandelbrot. Os PSNR vêm dessa execução de 10 s.)

Pico do IDR / quadro médio: 3,0× a 6 Mbps, 2,7× a 12, 2,1× a 30, 1,6× a 60. O IDR está **limitado pelo VBV**: com o VBV de 4 quadros a 12 Mbps o teto teórico é 100 KB, e o medido é 66–74. Com VBV de 1 quadro o IDR fica em 36 KB, a 1,47× do quadro médio, e o PSNR cai ~0,07 dB (VBV 1 vs 4: 28,67 vs 28,74 dB na mandelbrot; 32,78 vs 32,90 na testsrc2).

O custo de qualidade do intra refresh: −0,1 a −0,4 dB de PSNR-Y a bitrate igual. Cada onda também cria fatias (1643 fatias em 600 quadros no g=60: ~2,7 por quadro), o que aumenta o overhead de cabeçalho.

O fluxo de intra refresh (10 s) contém SEI de recovery point nos AUs 60, 120, 180… (9 em 600 quadros), com `recovery_frame_cnt` **59, 29 e 14** para g = 60, 30 e 15, `exact_match_flag = 1`.

### 1.5 Medição B (Chromium headless, `VideoDecoder` de software)

`node e2e/bench/estudo-intra-refresh.mjs --so=B`. Cortamos o fluxo no AU com SEI de recovery point e num P qualquer, prefixamos SPS/PPS e alimentamos o decoder com o 1º chunk marcado `key`:

| Entrada | g=60 | g=30 | sem intra refresh |
|---|---|---|---|
| No AU com SEI de recovery point, chunk 'key' | **recusado** (`DataError: A key frame is required`) | recusado | n/a |
| Num P qualquer, chunk 'key' | recusado | recusado | recusado |
| Num P qualquer, chunk 'delta' | recusado | recusado | recusado |
| No IDR (controle) | 240/240 quadros, bit-exatos | 240/240 | 240/240 |

Resultado consistente com a leitura do código-fonte: é a regra `recovery_frame_cnt == 0`. (O decoder libopenh264 do ffmpeg desta máquina também falha ao começar no recovery point; o ffmpeg do Fedora não traz decoder H.264 nativo, então não deu para comparar com o decoder do Firefox/Safari. **Não verificado** em Firefox e Safari.)

### 1.6 Ganho quantificado para os cenários do Tela

Algebra de `complexidade.md` §C4: o IDR custa `N × B_IDR` no link. Com o laço da escada saturando o link (`N·b = 0,75·U`), o tempo para drenar um IDR é **`k` intervalos de quadro**, `k = B_IDR / quadro médio`, independente de N e de U:

`t_drenar = N·B_IDR·8 / (0,75·U) = k · (N·b/60) / (0,75·U) ≤ k / 60 s`

| Encoder | k | `t_drenar` máx. | Bytes de um IDR no link, N = 1 / 5 / 20 / 50 |
|---|---|---|---|
| NVENC, VBV 4 q., 12 Mbps (medido, 66–74 KB) | 2,7–3,0 | 45–50 ms | 0,06–0,07 / 0,32–0,36 / 1,3–1,45 / 3,2–3,6 MB |
| premissa do C4 (150 KB) | 6,0 | 100 ms | 0,15 / 0,73 / 2,9 / 7,3 MB |
| WebCodecs OpenH264 (medido, 378 KB) | 15 vs o quadro nominal | 250 ms | 0,37 / 1,9 / 7,4 / 18,5 MB |
| NVENC, VBV 1 q. (medido) | 1,5 | 25 ms | 0,04 / 0,18 / 0,72 / 1,8 MB |

O `k` do OpenH264 é calculado contra o quadro nominal de 25 KB (12 Mbps), porque aquele encoder emitiu 33,7 Mbps (§5.3) e o quadro médio real foi 54 KB.

Leitura: **na trilha NVENC o IDR já é pequeno** (3× o quadro médio, limitado pelo VBV) e a janela ∝ N já o constante-iza. Na trilha **WebCodecs de software** ele é ~5× maior (378 vs 66–74 KB). O ganho de intra refresh seria tirar `k−1` quadros de rajada, mas o preço é inatingível pelo receptor (§1.3). Ganho real disponível sem intra refresh: **VBV de 1 quadro no IDR de reentrada** (~−50% de pico por IDR; medido: 74 → 36 KB), com o custo de qualidade já descrito.

### 1.7 Compatibilidade

R5: intra refresh não toca `contentHint`, `degradationPreference`, codec nem "parâmetros idênticos". ADR 0029: compatível, mas o `FilaDeInjecao` precisaria tratar "quadro com recovery point" como ponto de entrada, e o worker marca `frame.type` a partir do que o **encoder da isca** produz, não do payload injetado. Seria preciso reescrever o tipo do quadro, o que o spec do Encoded Transform só permite via construtor `RTCEncodedVideoFrame(frame, options)` (não há `setMetadata` por padrão; ver §2.4).

### 1.8 Experimento de validação (se mesmo assim se quiser tentar)

1. `node e2e/bench/estudo-intra-refresh.mjs` (já feito: A e B).
2. Em `e2e/um-encode.e2e.mjs`: substituir o IDR de entrada por injeção de um AU de recovery point com `recovery_frame_cnt = 0`. O NVENC não gera isso; seria preciso reescrever o SEI (um byte) e o encoder teria de ter o P seguinte referenciando só o quadro dentro da onda, o que o intra refresh normal não garante. **Não recomendado.**

---

## 2. Escalabilidade temporal (SVC L1T2/L1T3)

### 2.1 Estado do código

Nenhum: `config()` não passa `scalabilityMode`. A `FilaDeInjecao` entrega o quadro da vez ao sender, ou descarta a isca se não há quadro novo.

### 2.2 O que o Chromium aceita (medido, `isConfigSupported`, 1920×1080@60, 12 Mbps, `latencyMode:'realtime'`)

Chromium 151 headless (Playwright), sem GPU. Via `node e2e/bench/estudo-webcodecs-matriz.mjs`:

| Codec | `no-preference` / `prefer-software` | `prefer-hardware` | L1T1 / L1T2 / L1T3 | `bitrateMode` variable / constant / quantizer |
|---|---|---|---|---|
| H.264 Baseline, Main, High 4.2 e 5.1 | sim | não | sim / sim / sim | sim / sim / **não** |
| VP8 | sim | não | sim / sim / sim | sim / sim / não |
| VP9 perfil 0 | sim | não | sim / sim / sim | sim / sim / **sim** |
| AV1 Main 4.0 e 5.1 | sim | não | sim / sim / sim | sim / sim / **sim** |
| HEVC Main 4.1 e 5.1 | **não** | não | não | não |

`VideoDecoder` (1080p): H.264, VP8, VP9 e AV1 sim (`no-preference` e `prefer-software`); HEVC não. `MediaCapabilities` `type:'webrtc'`: H.264, VP8, VP9, AV1 sim; `video/H265` não (`supported=false`). `RTCRtpSender.getCapabilities('video')`: H.264 (`42001f`, `42e01f`, `4d001f`), VP8, VP9, AV1 (`level-idx=5`), **nenhum com `scalabilityModes`**. `VideoEncoderConfig.contentHint` é aceito e ecoado.

Hardware: o Playwright headless não tem GPU, então todas as células `prefer-hardware` dão "não". A execução no Electron do app (janela escondida, GPU real) **ficou pendente** (estourou 90 s sem imprimir; ver §7). Fonte secundária, **não verificada**: temporal layers em encoder de hardware existem no Windows (Media Foundation) e no VA-API, porque os dois aceleradores do Chromium trazem código para elas (`TemporalScalabilityIdExtractor`, `ts_number_layers` em [`media_foundation_video_encode_accelerator_win.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc)), mas isso depende do GPU/driver; confirmar com `isConfigSupported(... 'prefer-hardware', 'L1T2')` no alvo.

### 2.3 Medição: o descarte de camada é seguro?

`node e2e/bench/estudo-codec-encode.mjs` (§5): codifica 120 quadros, **extrai `metadata.svc.temporalLayerId`** de cada chunk, decodifica o fluxo completo, depois decodifica **apenas os chunks da camada 0** (mais o quadro-chave) e compara o hash de luma por timestamp com o fluxo completo.

| Configuração | Camadas T (quadros) | Bytes por camada | `nal_ref_idc` por camada (H.264) | Só base decodifica | Idênticos ao completo |
|---|---|---|---|---|---|
| H.264 L1T2 | T0: 60, T1: 60 | T0 62%, T1 38% | T0 = 3, **T1 = 0** | 60/60 | **60** |
| H.264 L1T3 | T0: 30, T1: 30, T2: 60 | 43% / 24% / 33% | T0 = 3, T1 = 1, **T2 = 0** | 30/30 | **30** |
| VP9 L1T3 | 30 / 30 / 60 | 37% / 39% / 25% | n/a | 30/30 | **30** |
| AV1 L1T3 | 30 / 30 / 60 | 40% / 29% / 31% | n/a | 30/30 | **30** |

Todos os quadros da camada-base decodificaram, sem erro, **idênticos** aos do fluxo completo. Em H.264 L1T2 os quadros T1 têm `nal_ref_idc = 0`: pela definição do padrão, nenhum outro quadro os referencia. **Em qualquer fluxo H.264 qualquer quadro com `nal_ref_idc == 0` pode ser descartado** sem metadado de SVC, só lendo o byte do NAL.

Custo no encoder (OpenH264, 12 Mbps de alvo, mesmo conteúdo; o encoder estourou o alvo, ver §5.3): L1T1 33,7 Mbps / 27,5 dB → L1T2 38,3 Mbps / 27,3 dB (**+14% de bits**) → L1T3 42,1 Mbps / 26,7 dB (**+25%**). A teoria de predição esperaria menos que isso (os quadros T1 predizem de 2 quadros atrás); este é o pior caso porque OpenH264 em tempo real não rebalanceia o QP entre camadas. **Não verificado** no NVENC.

### 2.4 Implicações de RTP e depacketizer (H.264)

- O Encoded Transform fica **antes do packetizer**: um quadro descartado no worker nunca ganha números de sequência, então a sequência RTP do espectador continua contígua. O depacketizer H.264 só exige isso ([`rtp_seq_num_only_ref_finder.cc` L108-115](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/rtp_seq_num_only_ref_finder.cc)).
- O localizador de referências de H.264 é "só número de sequência": ele **não valida** a referência real, só a ordem. Descartar quadros de não-referência é invisível a ele.
- Não precisamos de *frame marking* nem de *dependency descriptor*: o worker decide por `nal_ref_idc` (H.264) ou por `metadata.svc.temporalLayerId` do chunk do `VideoEncoder`. O espectador não precisa saber que há camadas. Nenhum desses cabeçalhos aparece em `RTCRtpSender.getCapabilities().headerExtensions` do Chromium 151 (a lista medida traz `toffset`, `abs-send-time`, `video-orientation`, `transport-wide-cc`, `playout-delay`, `video-content-type`, `video-timing`, `color-space`, `mid`, `rid`; nem `dependency-descriptor`, nem `frame-marking`).
- Spec: o processador "não pode reordenar quadros, mas pode atrasá-los ou descartá-los" ([W3C Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/), algoritmo `writeEncodedData`). Os campos `temporalIndex`, `spatialIndex`, `dependencies`, `frameId` existem em `RTCEncodedVideoFrameMetadata`.
- NVENC nativo: a API tem `enableTemporalSVC`/`numTemporalLayers` (H.264, HEVC, AV1) ([guia §8.12](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)), **mas o `nvh264enc` não expõe** (lista de propriedades acima). A propriedade `nonref-p` existe; medi com `ffmpeg -nonref_p 1` e **não produziu nenhum quadro não-referência** nas configurações do Tela (todos `nal_ref_idc = 3`). SVC temporal no caminho nativo exige o addon NVENC direto (D0c).
- Retomar T1 para um espectador **não precisa de IDR**: ele já tem todos os T0. Esse é o ponto que torna a camada temporal diferente de qualquer mudança de degrau.

### 2.5 Como isso convive com a R5 (proposta de regra)

A R5 diz: perder resolução, nunca framerate; parâmetros idênticos para todos; adaptação coletiva. A razão da "idêntica" é o reuso de encoder; o descarte de T1 **preserva o encoder único**. O que conflita é `maintain-framerate`. Proposta, para uma ADR nova (não altera código aqui):

> **Válvula individual de cadência.** Seja `W` o conjunto de espectadores cujo orçamento medido (`availableOutgoingBitrate` por caminho, pelo mesmo contrato da ADR 0017/0018) fica abaixo do piso do degrau atual mas acima de `0,70 × bitrate_do_degrau` (a base T0 tem ~62% dos bytes e queremos folga).
> 1. Se `|W| ≤ max(1, ⌊0,2·N⌋)`, a malha **não desce o degrau coletivo**: o worker passa a descartar T1 só para os senders de `W` (cada um vê 30 fps em vez de 60, mesma resolução).
> 2. Se `|W| > max(1, ⌊0,2·N⌋)`, vale a adaptação coletiva atual (a maioria está fraca, o degrau cai para todos).
> 3. Sair da válvula: orçamento ≥ 1,15 × `bitrate_do_degrau` por 10 s contínuos; religar T1 sem IDR.
> 4. O espectador vê uma etiqueta ("30 fps: sua conexão"), e o anfitrião tem a opção de desligar a válvula (padrão: **ligada só se a sala for aberta com L1T2**).
> 5. O governador do anfitrião continua medindo `availableOutgoingBitrate` (não o que ele grava), então a válvula não vira medição da própria atuação (ADR 0018).

**Custo coletivo da proposta:** +5 a +14% de bits em todos os espectadores para pagar a camada (§2.3: +14% pior caso, OpenH264; teoria ~5–10%; NVENC não medido). É o preço do seguro.

### 2.6 Ganho para os cenários

Um espectador fraco hoje obriga todos a descer um degrau (R5 coletiva). Com a válvula, ele fica com 30 fps na resolução cheia consumindo 62% dos bytes, e os outros N−1 mantêm 60 fps.

| N | Sem válvula, 1 espectador a 62–100% do degrau | Com válvula |
|---|---|---|
| 1 | n/a (o único espectador é a sala) | n/a |
| 5 | os 5 descem um degrau | 4 mantêm; 1 fica a 30 fps |
| 20 | os 20 descem | 19 mantêm; 1 a 30 fps |
| 50 | os 50 descem; PLI ∝ N | 49 mantêm |

Em upload de 10–300 Mbps o efeito depende de `N·b` vs `0,75·U`: o ganho só existe quando o gargalo é o **caminho do espectador**, não o upload do anfitrião (para o upload do anfitrião, quem decide é o governador coletivo; dropar T1 de poucos espectadores devolve `0,38·b` de upload por espectador, ~4,6 Mbps cada a 12 Mbps).

### 2.7 Experimento de validação

1. Estender `e2e/um-encode.e2e.mjs` com `scalabilityMode:'L1T2'` no `VideoEncoder`, `FilaDeInjecao` com `camadaMaxima` por sender, `ESPECTADORES=3` e um deles com `tc netem rate` a 65% do degrau.
2. Verificar (a) `framesPerSecond` do espectador fraco ≈ 30, (b) `pliCount` não cresce, (c) os outros dois a 60, (d) trocar `camadaMaxima` 1 → 0 → 1 sem `keyFramesDecoded` novo, (e) o `ViewerSession` não dispara reconexão por "congelamento" (risco: o vigia de mídia mede quadros/s).

---

## 3. Long-term reference e seleção de quadros de referência

### 3.1 Estado e teoria

Não há uso no código. O NVENC suporta LTR (`enableLTR`, `ltrNumFrames`; marcar e usar LTR por quadro) e invalidação de referência (`NvEncInvalidateRefFrames`), citados no guia ([§8.8 e §8.13](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)). O guia recomenda LTR, intra refresh, P não-referência e IDR forçado como as ferramentas de recuperação para "meios ruidosos" no uso de baixa latência (tabela §9). A ideia: o receptor avisa qual quadro perdeu (RPSI/LTR-ack); o encoder volta a predizer de um quadro que o receptor sabe ter.

### 3.2 Por que não serve aqui

Precisa de um canal de retorno por quadro e de um receptor que **referencie** quadros fora da sequência. O receptor libwebrtc de H.264 referencia "o quadro anterior" por número de sequência ([`rtp_seq_num_only_ref_finder.cc` L116-125](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/rtp_seq_num_only_ref_finder.cc): `frame->references[0] = last_picture_id_gop`) e **não implementa RPSI/LTR-ack para H.264** (não encontrei, na árvore lida, código de receptor que gere esse feedback; **conclusão por ausência, não verificada exaustivamente**). Além disso, o 1 encoder × N receptores implica N canais de retorno diferentes sobre o **mesmo** fluxo: um LTR escolhido para o espectador A não existe para B. A invalidação de referência (`NvEncInvalidateRefFrames`) é uma por encoder, afetaria todos.

Conclusão: **LTR não resolve perda por espectador em um encode compartilhado.** O que serve é NACK/RTX (já ligado) mais IDR coalescido (já feito). Não propor.

---

## 4. HEVC e AV1

### 4.1 Estado do código

`CODEC = 'avc1.42e02a'` em `webcodecs-codificador.ts`; `profile=constrained-baseline` e `nvh264enc` em `tela-captura.c`; R5 item 3 `videoCodec: 'h264'`.

### 4.2 Disponibilidade de hardware de encode (fontes secundárias, 2026; **não verificadas por mim, exceto AV1 NVENC nesta máquina**)

| Codec | NVIDIA | Intel | AMD | Apple |
|---|---|---|---|---|
| H.264 | todas | QSV | AMF | VideoToolbox |
| HEVC | NVENC desde Maxwell 2ª geração | QSV | AMF | VideoToolbox |
| AV1 | **RTX 40/50** (verificado: `av1_nvenc` presente no ffmpeg e codifica na RTX 4050 desta máquina) | Arc | RX 7000/9000 | decode só em M3+/A17; **sem encode de AV1** (fonte secundária) |

Fonte: [forasoft](https://www.forasoft.com/learn/video-quality/articles-vqm/codec-comparison-real-content), [streamersize](https://streamersize.com/blog/nvenc-av1-explained/), [dataset WebCodecs 2026](https://webcodecsfundamentals.org/datasets/codec-analysis-2026/) (363 milhões de testes em 1,14 milhão de sessões; AV1 encode ~88% via WebCodecs — ou seja, software —, mas com hardware só ~8% em 10 bits).

### 4.3 Suporte de decode e WebRTC por navegador

- **Chrome/Edge/Firefox desktop:** AV1 decode ~91% das sessões; macOS Safari ~24%, iOS Safari ~33% ([dataset](https://webcodecsfundamentals.org/datasets/codec-analysis-2026/)).
- **HEVC no WebRTC do Chrome:** "Intent to Ship", desde o Chrome 136, **só por hardware, sem fallback de software** (estimativa de cobertura: Windows 75%, macOS 99%, Android 86%) ([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c)). Linux depende de VA-API. **Medido aqui:** o Chromium 151 headless diz `supported=false` para `video/H265` e `HEVC` em `isConfigSupported` (esperado sem GPU/VA-API).
- **Safari/Firefox no WebRTC (AV1/HEVC):** fontes secundárias **conflitam** (uma diz que Safari tem HEVC universal em mídia; outras dizem que AV1 e VP9 não estão em Safari WebRTC). Não há como afirmar. Regra do estudo: **sempre medir com `RTCRtpReceiver.getCapabilities('video')` no espectador** e não confiar em tabela.
- O Chromium 151 headless desta máquina anuncia no receptor: VP8, VP9 (perfis 0–3), H.264 (`42001f`, `42e01f`, `4d001f`, `f4001f`), AV1 (`profile=0` e `1`), mais RTX/RED/ULPFEC/FlexFEC-03. Sem H.265.

### 4.4 Ganho de bitrate a PSNR igual: o que foi medido e o que a literatura diz

**Medido (NVENC H.264 High vs NVENC AV1, mesma GPU, CBR, 1080p60, 4 s; PSNR-Y):** `node e2e/bench/estudo-nvenc-ratecontrol.mjs --grupo=av1`.

| Mbps | mandelbrot H.264 high | AV1 | testsrc2 H.264 high | AV1 |
|---|---|---|---|---|
| 4 | 27,04 dB | **28,59** | 32,51 | **32,70** |
| 6 | 28,36 | 28,75 | 32,72 | 32,80 |
| 8 | 28,56 | 28,87 | 32,81 | 32,87 |
| 12 | 28,82 | 29,04 | 32,94 | 32,97 |
| 16 | 29,00 | 29,15 | 33,00 | 33,02 |

Interpolando o bitrate de H.264 que daria o mesmo PSNR do AV1: mandelbrot AV1@4 ≈ H.264@8,3 (**−52%**), AV1@6 ≈ H.264@10,9 (−45%), AV1@8 ≈ H.264@12,7 (−37%); testsrc2 AV1@4 ≈ H.264@5,8 (−31%), AV1@6 ≈ @7,9 (−24%), AV1@8 ≈ @9,8 (−18%), AV1@12 ≈ @14 (−14%). **Faixa: −14% a −52%, e o ganho cai quando o bitrate sobe.** Ressalva forte: as curvas PSNR×bitrate dessas fontes sintéticas são quase planas (0,5 dB entre 4 e 16 Mbps), o que amplifica o ganho em bitrate; e PSNR não é percepção. Nos pontos baixos (4–8 Mbps por espectador), que é onde N=20–50 nos coloca, o AV1 vale mais.

**Literatura:** a NVIDIA publica "40% de economia de bitrate do AV1 sobre H.264 a 1080p60 com qualidade semelhante" (42 dB PSNR a 7 Mbps no AV1 contra 11 Mbps no H.264, preset de baixa latência no H.264) em GPUs Ada ([NVIDIA blog](https://developer.nvidia.com/blog/improving-video-quality-and-performance-with-av1-and-nvidia-ada-lovelace-architecture)). O artigo não trata de jogo nem de B-frames. Fontes secundárias: AV1 −55%, HEVC −44% sobre H.264 por VMAF em conteúdo de streaming (BD-rate, não tempo real) ([forasoft](https://www.forasoft.com/learn/video-quality/articles-vqm/codec-comparison-real-content)). Para conteúdo de tela (AV2, não AV1) são citados >44% em modo de baixo atraso, **não aplicável a AV1** ([arXiv 2605.15800](https://arxiv.org/pdf/2605.15800)).

**Medido em software no Chromium (Parte 6b):** AV1 e VP9 chegam a PSNR de luma semelhante (27,4–27,8 dB) com 15–16 Mbps onde o OpenH264 gasta 33,7 Mbps (~2× menos), mas o OpenH264 é um encoder fraco e **não fechou o alvo** (§5.3); serve de ordem de grandeza, não de benchmark de NVENC.

### 4.5 O que seria preciso no desenho, e a estratégia de codec comum

O um-encode-N-envios exige **um codec só** por transmissão: a isca é codificada pelo sender no codec negociado (isca 160×90 é barata em qualquer um), e o payload injetado tem de estar no mesmo codec e no formato de RTP dele. Cada espectador negocia sua SDP separadamente (mesh), então o anfitrião **pode** oferecer codec diferente por espectador; o conflito é que cada codec distinto precisa de **seu** encode.

Estratégia proposta (dois níveis, no máximo dois encodes):

1. **Nível 1 (padrão): H.264 High**, como hoje. Todos os espectadores decodificam.
2. **Nível 2 (opcional): AV1 (ou HEVC no Windows/macOS)** quando o anfitrião tem encoder de hardware (`isConfigSupported(..., 'prefer-hardware')` ou NVENC AV1) **e** ≥ 1 espectador anuncia o codec em `getCapabilities` no `RTCRtpReceiver` **e** decode eficiente em energia (`MediaCapabilities.decodingInfo({type:'webrtc'}).powerEfficient`).
3. **Corte:** o encoder do nível 2 só liga se `n_capazes ≥ max(2, 0,5·N)`. Os demais espectadores ficam no nível 1. O custo é um segundo encode (NVENC faz ≥ 2 sessões em paralelo; **verificar o limite de sessões da GPU do usuário**; o driver da GeForce já relaxou o antigo teto de 3, **não verificado aqui**).
4. Um espectador que entra e não suporta o nível ativo recebe o nível 1 mesmo que a sala esteja no 2, sem derrubar ninguém.
5. HEVC: só Chrome/Safari com hardware, decisão por espectador pelos mesmos testes. Seu ganho tende a ficar entre H.264 e AV1 (fonte secundária: ~44% vs ~55%).

**Ganho em capacidade** (piso de 12,4 Mbps por espectador a 1080p60, ADR 0010/D1; `0,75·U`; AV1 com −30% conservador e −40% NVIDIA):

| U (Mbps) | H.264 | AV1 −30% (8,7 Mbps) | AV1 −40% (7,4 Mbps) |
|---|---|---|---|
| 10 | 0 | 0 | 1 |
| 50 | 3 | 4 | 5 |
| 100 | 6 | 8 | 10 |
| 300 | 18 | 25 | 30 |

Para N=50, mesmo com AV1, 1080p60 só cabe em ~500 Mbps; o ganho aparece como **um degrau a mais da escada** com o mesmo orçamento.

**Risco principal:** `videoCodec: 'h264'` é invariante da R5 ("único com HW encode universal"); o raciocínio mudou com o NVENC AV1 e o decode universal em Chrome/Edge/Firefox, mas a R5 pede ADR. Outros: AV1 por SW no espectador gasta CPU em 1080p60 (decoder dav1d/libaom; `powerEfficient` mede isso); AV1 nos cabeçalhos RTP (OBU, dependency descriptor para SVC); o IDR do AV1 (`keyframe`) é maior em conteúdo detalhado (249 KB vs H.264 378 KB na medição de software; em NVENC não medido).

### 4.6 Experimento de validação

1. `node e2e/bench/estudo-webcodecs-matriz.mjs` no Electron do app (GPU real; ver §7).
2. `e2e/qualidade.e2e.mjs` com `CODEC=av1`, dois Chrome reais, anfitrião com NVENC AV1: comparar `qualityLimitationReason`, bpp efetivo, `framesDecoded`.
3. Medir energia do espectador com `MediaCapabilities.decodingInfo` e `powerEfficient` em 3 máquinas (Intel iGPU, AMD, Apple M1 sem decode de AV1).

---

## 5. Controle de taxa, VBV, presets e conteúdo estático

### 5.1 Estado do código

- NVENC: `rc-mode=cbr`, `bitrate` reaplicado a cada mudança de fps medido com fator `clamp(fps_alvo/fps_medido, 1, 2)` (`tela-captura.c:180-186`), VBV de 4 quadros, `preset=p4`, `tune=ultra-low-latency`, `zerolatency=true`, `spatial-aq=true`, `bframes=0`, `gop-size=-1`, **sem** `multi-pass`, **sem** `temporal-aq`, **sem** lookahead.
- WebCodecs: `bitrateMode:'variable'`, sem VBV (a API não expõe); `latencyMode:'realtime'`.

### 5.2 Teoria

O guia do NVENC recomenda para jogo em baixa latência: "tune ultra-low-latency ou low-latency; CBR; multipass quarter/full; **VBV de um quadro** (`bitrate/framerate`); B-frames unidirecionais; GOP infinito; AQ; LTR, intra refresh, P não-referência e IDR forçado para recuperação" ([guia §9](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)). Explica que o *temporal AQ* "pode aumentar a flutuação de bits por quadro" e que o *multi-pass* aproxima o encoder do alvo do CBR.

### 5.3 Medições

`node e2e/bench/estudo-nvenc-ratecontrol.mjs --grupo=...` (ffmpeg `h264_nvenc`, mesma GPU; 1080p60; 4 s; fontes `mandelbrot` e `testsrc2`; PSNR-Y contra a fonte sem perdas; o decoder do PSNR é o OpenH264, o único H.264 disponível no ffmpeg desta máquina).

**Preset p1..p7 (tune ull, CBR 12 Mbps):** PSNR-Y igual dentro de **0,03 dB** (mandelbrot 28,72→28,75; testsrc2 32,90→32,91). O preset **não** é alavanca de qualidade neste regime. Vazão de encode (testsrc2): 333 q/s em p1, 254 em p4, 200 em p7: em qualquer um o encoder sobra >3× o tempo real.

**Variantes de CBR (12 Mbps, p4):**

| Variante | mandelbrot Mbps / PSNR / maior quadro | testsrc2 Mbps / PSNR / maior quadro |
|---|---|---|
| CBR base | 12,01 / 28,74 / 29,9 KB | 12,01 / 32,90 / 34,5 KB |
| VBR maxrate 1,5× | 14,34 / 28,83 / 47,8 KB | 13,61 / 32,94 / 42,0 KB |
| `tune ll` | idêntico ao base | idêntico |
| multipass quarter | 12,01 / 28,75 / 36,8 KB | 12,01 / 32,90 / 29,9 KB |
| multipass full | 12,01 / 28,74 / 36,3 KB | 12,01 / 32,92 / 28,6 KB, **89 q/s** (de 236) |

Nada disso mexe mais de 0,05 dB; `multipass full` custa 2,6× em vazão. `tune ll` e `ull` dão o mesmo fluxo aqui (a opção `zerolatency` domina).

**VBV (CBR 12 Mbps):**

| VBV | mandelbrot PSNR / pico | testsrc2 PSNR / pico |
|---|---|---|
| 1 quadro | 28,67 / 25,8 KB | 32,78 / 24,4 KB |
| 2 | 28,73 / 30,0 | 32,90 / 26,2 |
| **4 (hoje)** | 28,74 / 29,9 | 32,90 / 34,5 |
| 8 | 28,75 / 33,2 | 32,91 / 40,8 |
| 30 | 28,77 / 33,5 (Mbps 12,9) | 32,91 / 40,8 (12,16) |

VBV de 1 quadro custa 0,07–0,12 dB e baixa o pico em 14–30%. VBV ≥ 8 deixa o bitrate estourar (12,89 Mbps com 30 quadros). O de 4 quadros é um bom meio-termo, consistente com a escolha existente.

**AQ:** sem AQ, spatial, spatial+temporal, temporal sozinho: a diferença é ≤ 0,05 dB. No testsrc2 o AQ espacial **piora** 0,03 dB; na mandelbrot melhora 0,04 dB. Ruído de medição para esta fonte.

**Perfil (a lacuna da ADR 0016):** baseline vs main vs high, 8 a 16 Mbps:

| Fonte | Δ PSNR (high−baseline) | inclinação PSNR/Mbps | Bitrate equivalente poupado |
|---|---|---|---|
| mandelbrot | +0,09 dB a 8, 10, 12 Mbps | 0,068 dB/Mbps | **~1,3 Mbps a 12 Mbps (~11%)** |
| testsrc2 | +0,04 dB | 0,032 dB/Mbps | **~1,2 Mbps a 12 Mbps (~10%)** |

**~10% de bitrate** com CABAC e transformada 8×8, em linha com os "10–15%" da ADR 0016 (agora **medido**). Main e High são equivalentes aqui (+0,01 dB). Vazão igual.

**Tela quase parada** (testsrc2 congelado + remendo de 100×100 em movimento): 

| Variante | 12 Mbps alvo | 30 Mbps alvo | 60 Mbps alvo |
|---|---|---|---|
| CBR (hoje) | **12,00 Mbps**, quadro mínimo 1147 B | **30,00** | **60,00** |
| VBR maxrate 1,5× | **1,37 Mbps** | **2,05** | **2,00** |

PSNR-Y: 43,23 (CBR) vs 43,24 dB (VBR) a 12 Mbps; 37,49 vs 37,48 dB a 30 Mbps (o PSNR do CBR de 60 Mbps não foi medido; o decoder OpenH264 falhou nesse fluxo, e há sinal de que o decoder trate mal o preenchimento do CBR em alto bitrate, então os PSNR acima devem ser lidos só como "iguais entre CBR e VBR no mesmo alvo"). Isto é: **o CBR do NVENC gasta o orçamento inteiro em imagem que já está boa**. É o NVENC se comportando como CBR (preenche com QP baixo), entre 8,8× e 30× a mais bits.

**Software H.264 do Chromium (WebCodecs, OpenH264) não fecha o alvo neste conteúdo:** alvo 12 Mbps → 33,7 Mbps; alvo 4 Mbps → 32,1 Mbps; com `bitrateMode:'constant'` o mesmo (33,7 / 32,1). O `VideoEncoder` de VP9/AV1 chega mais perto (15,1/15,9 a 12 Mbps; 11,6/10,9 a 6). **Para o Tela: o caminho WebCodecs-software em conteúdo difícil estoura o orçamento da malha no mesmo instante**, e a malha só descobre pelo `bytesSent`. A conclusão é limitada (conteúdo sintético que o QP máximo do OpenH264 não consegue conter); mas é consistente com a lembrança da ADR 0019 de que "o nominal é calibração". Não verificado no encoder de hardware MFT.

### 5.4 Proposta de taxa por conteúdo (detalhe do item 2 da tabela)

1. Nível de "movimento": razão `bytes_P_médios / (bitrate/fps)` do encoder (o código já tem `msPorQuadro` e o tamanho dos quadros no caminho de saída), `estático` se < 10% por 2 s.
2. Em `estático`: NVENC `rc-mode` de CBR para VBR com `max-bitrate = orçamento` e `bitrate = 0,25 × orçamento`; sai de `estático` ao primeiro quadro > 50% do orçamento.
3. Trocar `rc-mode` ao vivo no `nvh264enc` renasce o encoder (`aplicar_vbv` e `tela-captura.c:189-196` já documentam que mexer no VBV força IDR); então a troca deve ser **só no início** da sala (`VBR` sempre, com o teto = orçamento, e a malha deixa de depender de CBR para medir). Alternativa sem trocar modo: `bitrate` baixo e `max-bitrate` = orçamento em VBR **permanente**.
4. **O risco que vale tudo:** ADR 0018 — com VBR a 1,4 Mbps o `availableOutgoingBitrate` do sender decai a `~1,5 × acked` ≈ 2 Mbps, e quando o jogo volta, o encoder pede 12 Mbps e o BWE leva dezenas de segundos para subir. Por isso a proposta inclui **segurar o último orçamento medido por T segundos** e a bancada `e2e/malhas.sim.mjs` com um cenário "tela parada → jogo". Isso vale os 89% só se essa cadeia for fechada.

### 5.5 Experimento de validação

1. `node e2e/bench/estudo-nvenc-ratecontrol.mjs --grupo=estatica --mbps=12` (feito) para a conta do codificador.
2. Em `e2e/malhas.sim.mjs` acrescentar cenário `parado(10 s) → mexendo`, verificando que o degrau volta a 1080p60 em ≤ 3 s e que `availableOutgoingBitrate` volta a `≥ 0,9 × orçamento`.
3. Em máquina real: `nvidia-smi dmon -s u` (utilização do encoder) e MangoHud (FPS do jogo) durante tela parada com CBR vs VBR (energia/calor do encoder; **não medido**).

---

## 6. Medições: método, números e limites

### 6.1 Ambiente

- CPU AMD Ryzen 7 7435HS (16 threads); GPU NVIDIA GeForce RTX 4050 Laptop; Fedora (kernel 7.2); Chromium headless 151.0.7922.34 (Playwright); ffmpeg 8.1.2 com `h264_nvenc`, `av1_nvenc`, `hevc_nvenc`, `libopenh264` (único decoder H.264; não há decoder H.264/HEVC nativo nem `libx264`).
- Sem GPU no Chromium headless: `prefer-hardware` não é testável ali.
- Fontes sintéticas: nenhuma é gameplay real. Servem para o que o encoder **aceita** e para ordens de grandeza, não como veredicto de qualidade.

### 6.2 (a) Matriz de capacidades do Chromium

`node e2e/bench/estudo-webcodecs-matriz.mjs` (Chromium headless; o modo Electron estourou o tempo). Tabela completa em §2.2. Resumo:

| | H.264 | HEVC | AV1 | VP9 | VP8 |
|---|---|---|---|---|---|
| `VideoEncoder`, `no-preference` / `prefer-software` | sim | **não** | sim | sim | sim |
| `prefer-hardware` | não (sem GPU) | não | não | não | não |
| L1T2 / L1T3 | sim | n/a | sim | sim | sim |
| `bitrateMode: quantizer` | **não** | n/a | **sim** | **sim** | não |
| `VideoDecoder` | sim | não | sim | sim | sim |
| `MediaCapabilities` webrtc encode/decode | sim | **não** | sim | sim | sim |
| `getCapabilities` do sender com `scalabilityModes` | nenhum | | nenhum | nenhum | |

APIs: `VideoEncoder`, `VideoDecoder`, `MediaStreamTrackProcessor`, `MediaStreamTrackGenerator`, `RTCRtpScriptTransform`, `RTCEncodedVideoFrame(frame, options)` e `RTCRtpReceiver.jitterBufferTarget`/`playoutDelayHint` presentes. **Ausentes** (neste build): `RTCEncodedVideoFrame.setMetadata` (atrás de flag, o Electron liga), `createEncodedSource`, `RTCRtpScriptTransformer.generateKeyFrame`, `VideoTrackGenerator`.

### 6.3 (b) Codificação sintética no Chromium (software)

`node e2e/bench/estudo-codec-encode.mjs --quadros=120 --mbps=12`. Conteúdo: textura rolante de 2 camadas (11 e 23 px/quadro), 8 sprites girando, HUD semi-estático; 1080p60, I420, `latencyMode:'realtime'`, `prefer-software`, `bitrateMode:'variable'`, 120 quadros. Tempo de parede = `encode()` + `flush()` com fila ≤ 4, sem contar a geração dos quadros. Três repetições de L1T1 deram os mesmos números.

| Configuração | ms/quadro | q/s máx. | IDR KB | P médio KB | Mbps efetivo (alvo 12) | PSNR-Y médio / mín |
|---|---|---|---|---|---|---|
| H.264 CBP `avc1.42e02a` | 6,6 | ~150 | 378 | 54,2 | **33,7** | 27,5 / 26,0 |
| H.264 High `avc1.640028` | 8,9 | ~112 | 378 | 54,2 | 33,7 | 27,5 / 26,0 |
| VP8 | 7,6 | ~130 | 211 | 35,3 | 18,1 | 26,9 / 26,6 |
| VP9 perfil 0 | 11,9 | ~84 | 385 | 27,7 | 15,1 | 27,4 / 25,8 |
| AV1 `av01.0.08M.08` | 12,4 | ~80 | 249 | 30,5 | 15,9 | 27,8 / 26,5 |
| H.264 L1T2 | 6,7 | ~149 | 378 | 65,6 | 38,3 | 27,3 / 25,5 |
| H.264 L1T3 | 7,2 | ~139 | 378 | 75,3 | 42,1 | 26,7 / 24,8 |
| VP9 L1T3 | 9,9 | ~101 | 648 | 36,9 | 20,7 | 26,9 / 25,8 |
| AV1 L1T3 | 11,9 | ~84 | 295 | 40,2 | 20,8 | 28,1 / 26,7 |

(A linha H.264 High mostra 8,9 ms em uma execução e coincidência de bytes com CBP: o OpenH264 do Chromium ignorou o perfil e emitiu o mesmo fluxo — **o `avc1.64…` é aceito mas o encoder de software produz Constrained Baseline**; relevante porque o Linux NVIDIA cai em software hoje.)

**Leitura:** (1) todos os codecs de software sustentam 1080p60 nesta máquina de 16 threads (≥ 80 q/s); o uso de CPU não foi medido, só o tempo de parede; (2) a ~27,5 dB, o H.264 de software precisou de ~2,1× o bitrate do AV1/VP9; (3) o H.264 de software estourou o alvo em 2,8× e não obedece `bitrateMode`; (4) a camada temporal em H.264 custa +14%/+25% de bits no OpenH264.

**Limites:** quadros curtos (2 s) e conteúdo sintético; AV1 de software em tempo real em 16 threads não representa um notebook de 4; o OpenH264 não é o encoder de hardware que o Windows usará; a primeira execução do AV1 mediu 40 ms/quadro e as seguintes 12 ms (variação de máquina ocupada; reportamos as 3 execuções estáveis).

---

## 7. O que não foi verificado

| Item | Como verificar |
|---|---|
| Matriz `prefer-hardware` e SVC em hardware | `pnpm --filter @tela/desktop exec electron ../../e2e/bench/estudo-webcodecs-matriz.mjs` numa sessão gráfica (a execução desta sessão estourou 90 s sem imprimir; provável espera por GPU/`app.whenReady`; reduzir o laço ou rodar sem `--json`) |
| Decoder do Firefox e Safari ao começar em recovery point | repetir `estudo-intra-refresh.mjs --so=B` nesses navegadores (Firefox: `VideoDecoder` ao vivo; Safari: `MediaSource`) |
| Overhead de L1T2 no NVENC | exigir o addon NVENC (`enableTemporalSVC`), medir bytes por camada |
| Limite de sessões NVENC simultâneas (nível 2 de codec) | `nvidia-smi` com duas sessões `av1_nvenc` + `h264_nvenc` |
| Percepção e qualidade em gameplay real | VMAF em captura real de jogo, nos pontos 4/6/8/12 Mbps |
| Energia/CPU do espectador com AV1 | `chrome://webrtc-internals` + `powerEfficient` em 3 máquinas |
| Latência glass-to-glass | humano com câmera de 240 fps (AGENTS.md) |
| Impacto da taxa VBR na malha | `e2e/malhas.sim.mjs` com o cenário "parado → jogo" proposto em §5.5 |

## 8. Arquivos novos

- `e2e/bench/estudo-intra-refresh.mjs` — partes A (NVENC) e B (decoder do Chromium).
- `e2e/bench/estudo-codec-encode.mjs` — codificação sintética por codec e camadas temporais.
- `e2e/bench/estudo-nvenc-ratecontrol.mjs` — presets, CBR/VBR, VBV, AQ, perfil, AV1, tela parada.
- `e2e/bench/estudo-webcodecs-matriz.mjs` — matriz de capacidades (herdado, não alterado).

Os scripts de NVENC gravam um cache de fontes sem perdas em `os.tmpdir()/tela-estudo-fontes` (185 MB para os três clipes de 4 s); apague quando terminar.


## Aplicado (2026-10-02): VBV do NVENC de 4 para 2 quadros

`VBV_EM_QUADROS` 4 → 2 em `tela-captura.c`, só no início e na troca de tamanho (o VBV com o fluxo andando solta IDR; não há caminho novo de IDR). Medido com `h264_nvenc` (ffmpeg), 12 Mbps CBR, 1080p60, p4/ull, baseline, 4 s; "corte" = mandelbrot 2 s + testsrc2 2 s:

| fonte | VBV | IDR inicial | maior P | PSNR-Y |
|---|---|---|---|---|
| mandelbrot | 1 / **2** / 4 | 27,2 / **42,0** / 67,9 KB | 25,8 / 30,0 / 29,9 KB | 28,669 / **28,734** / 28,739 dB |
| testsrc2 | 1 / **2** / 4 | 28,8 / **38,8** / 57,2 KB | 24,4 / 26,2 / 34,5 KB | 32,782 / **32,900** / 32,902 dB |
| corte | 1 / **2** / 4 | 27,2 / **42,0** / 67,9 KB | 25,8 / 29,4 / 29,9 KB | 29,074 / **29,122** / 29,124 dB |

VBV 2: IDR −38 % (mandelbrot) e −32 % (testsrc2) por −0,005 e −0,002 dB; o 1 daria o −50 % do estudo, mas a −0,07 a −0,12 dB. O maior quadro P depois do corte de cena ficou igual ao de VBV 4 (29 KB), então a folga para troca de cena em jogo se mantém. Medido só o encoder: o efeito no IDR do `tela-captura` real (e se o IDR "borrado" da ADR 0010 aparece no espectador que entra) precisa de humano com GPU: transmitir, entrar um espectador novo, comparar o tamanho do 1º quadro-chave (`keyFramesDecoded`/bytes do `inbound-rtp`).

## Referências

**Documentos do repositório:** `AGENTS.md` (R1–R8), `docs/desktop/D0b-um-encode-n-envios.md`, `docs/engenharia/complexidade.md` §C4, ADR 0010, 0016, 0017, 0018, 0019, 0020, 0029, 0030.

**Primárias:**
- NVIDIA, [NVENC Video Encoder API Programming Guide 13.0](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html): intra refresh (§8.13), LTR (§8.8), temporal SVC (§8.12), multi-pass (§3.8.4), AQ (§8.5), configurações recomendadas (§9).
- NVIDIA, [Improving video quality and performance with AV1 and NVIDIA Ada Lovelace](https://developer.nvidia.com/blog/improving-video-quality-and-performance-with-av1-and-nvidia-ada-lovelace-architecture) (40% a 1080p60).
- W3C, [WebCodecs](https://www.w3.org/TR/webcodecs/) e [AVC codec registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/).
- W3C, [WebRTC Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/).
- Chromium: [`video_decoder.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webcodecs/video_decoder.cc), [`avc.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/formats/mp4/avc.cc), [`media_switches.cc` (`kParseSEIRecoveryPoints`)](https://chromium.googlesource.com/chromium/src/+/main/media/base/media_switches.cc), [`media_foundation_video_encode_accelerator_win.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc).
- libwebrtc: [`video_rtp_depacketizer_h264.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/rtp_rtcp/source/video_rtp_depacketizer_h264.cc), [`rtp_seq_num_only_ref_finder.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/rtp_seq_num_only_ref_finder.cc), [`rtp_video_stream_receiver2.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/video/rtp_video_stream_receiver2.cc), [`h26x_packet_buffer.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/h26x_packet_buffer.cc).
- blink-dev, [Intent to Ship: H265 (HEVC) codec support in WebRTC](https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c).
- FFmpeg, [patch de intra refresh no NVENC](https://patchwork.ffmpeg.org/project/ffmpeg/patch/1630893718-16160-1-git-send-email-lance.lmwang@gmail.com/).

**Secundárias (incerteza maior):**
- [Dataset WebCodecs 2026](https://webcodecsfundamentals.org/datasets/codec-analysis-2026/) — suporte de AV1/HEVC por navegador, medido por sessões reais.
- [Fora Soft — H.264 vs HEVC vs AV1](https://www.forasoft.com/learn/video-quality/articles-vqm/codec-comparison-real-content) — BD-rate em streaming.
- [Streamersize — NVENC AV1](https://streamersize.com/blog/nvenc-av1-explained/) — disponibilidade de AV1 em GPU.
- [arXiv 2605.15800 — AV2](https://arxiv.org/pdf/2605.15800) — screen content em AV2, **não** AV1.
- [Icetester](https://icetester.org/blog/24-webrtc-browser-compatibility) e [Ant Media](https://antmedia.io/webrtc-browser-support/) — suporte de WebRTC por navegador; **conflitam entre si**, tratar como indício.
