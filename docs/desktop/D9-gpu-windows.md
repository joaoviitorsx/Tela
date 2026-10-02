# D9 — Codificar na GPU no Windows

**Data:** 2026-10-02 · **Plano:** `PLANO-desktop.md` §1.1, §6.3 · **Antes:** D0b (um encode, N envios), D2 (captura) · **Chromium lido:** tag `152.0.7977.130` (a do Electron 44.5.1)

**Pergunta:** no Windows, o app codifica na GPU (NVENC, AMF, Quick Sync) para
quem joga perder o mínimo de FPS? E, se não codifica, o que construir?

**Resposta curta:** codifica. O `VideoEncoder` do Chromium no Windows só usa
encoder de hardware do Media Foundation: o MFT de software da Microsoft nunca
entra. Quando a GPU não aceita, cai no OpenH264. O que faltava era **saber**
qual dos dois está codificando, porque o `no-preference` troca para software
sem avisar, e **reagir** quando a GPU falha no meio da transmissão. Foi o que
mudou (§3).

O helper nativo para Windows (WGC + Media Foundation com textura) **não foi
construído**. A investigação aponta que o custo que sobra depois do encode por
hardware é a captura do próprio Chromium, que passa pela CPU. Mas ninguém
mediu esse custo contra o FPS de um jogo, e um helper C++ compilado às cegas
seria a maior fonte de risco do app. Ele fica atrás de um portão de medição
(§2.2), com o desenho pronto.

---

## 1. Investigação

Fontes primárias: o código do Chromium na tag `152.0.7977.130`. A base dos
links abaixo é `https://github.com/chromium/chromium/blob/152.0.7977.130/`,
abreviada como **CR/**, e os números de linha são dessa tag. As afirmações
marcadas com "conferido" foram lidas por mim no arquivo. As demais vêm da
leitura de um subagente, com o arquivo e a linha citados.

### 1.1 (a) Como o `hardwareAcceleration` vira encoder

**Blink (`CR/third_party/blink/renderer/modules/webcodecs/video_encoder.cc`)**

- `CreateMediaVideoEncoder` (L735–761, conferido):
  - `prefer-hardware`: `return result;`. É só o acelerado; sem ele, o `configure` falha com `error()` ("Encoder creation error.").
  - `no-preference`: o acelerado entra **embrulhado** em `media::VideoEncoderFallback`, com o OpenH264 como reserva. Sem acelerado, vai direto ao software.
- `VideoEncoderFallback` (`CR/media/video/video_encoder_fallback.cc`, conferido: `FallbackInitialize` L189, `FallbackEncode`):
  - Se o hardware falha ao iniciar **ou no primeiro `Encode` com erro**, cria o software e reenvia o quadro.
  - O JavaScript **não recebe `error()`**. Só o MediaLog muda.
  - Consequência: com `no-preference`, nenhum rótulo "hardware" é confiável.
- `GetRequiredEncoderType` (L586–596, conferido) e `MayHaveAndAllowSelectOSSoftwareEncoder` (`CR/media/base/supported_types.cc`): para H.264, só Mac e Android têm encoder de software do sistema. **No Windows o tipo exigido é sempre hardware.**
- Nenhuma condição depende de `latencyMode`. O que manda H.264 para software (`IsAcceleratedConfigurationSupported`, L186–270):
  - GPU na blocklist ou workaround `disable_accelerated_h264_encode`;
  - tamanho fora do mínimo ou do máximo do MFT;
  - modo de bitrate não suportado;
  - formato diferente de 4:2:0 de 8 bits;
  - dimensões ímpares. O Tela já arredonda para par (`alvoDoCodificador`).

**Media Foundation (`CR/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc`, MFVEA)**

- **Enumeração** (`mf_video_encoder_util.cc` L272/L360, conferido): `MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER`. Percorre os adaptadores na ordem do DXGI e exige MFT **assíncrona** (L1502). A primeira que ativa vence.
- **NVIDIA e Constrained Baseline** (L1433–1438, conferido): o MF pula a NVIDIA quando `is_constrained_h264`, por causa do [crbug 1088650](https://groups.google.com/a/chromium.org/g/feature-media-reviews/c/t7DPtMGsK2Q). Com CBP, o MFT da NVIDIA gerava de 50 a 300 quadros-chave por minuto e não passava de 360p, e a ativação foi revertida.
  - O WebCodecs não liga `is_constrained_h264` (padrão `false`, `CR/media/video/video_encode_accelerator.h`). Então `avc1.42e02a` vira `eAVEncH264VProfile_Base` (util L58–71) e **usa a NVIDIA**.
  - Já o WebRTC (`RTCVideoEncoderFactory::IsConstrainedH264`) liga o sinal. Por isso o caminho de um encoder por `RTCPeerConnection` (`mesh-transport`), com `42e01f`, **nunca usa NVENC no Windows**: cai na iGPU ou no OpenH264. É mais um motivo para o app transmitir pelo "um encode" (ADR 0029).
- **Baixa latência:** `CODECAPI_AVLowLatencyMode = true` quando `latencyMode: 'realtime'` (L1833–1838, conferido).
- **Sem B-frames:** em Baseline não há B-frames por definição. A [documentação do encoder H.264 da Microsoft](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder) diz "For Baseline profile, the number of B frames is always zero". O MFVEA só grava `AVEncMPVDefaultBPictureCount = 0` explicitamente para Qualcomm.
- **GOP:** `kDefaultGOPLength = 3000` (L75, conferido). O WebCodecs não passa intervalo, então os quadros-chave são só os nossos (`encode(q, {keyFrame: true})` vira `CODECAPI_AVEncVideoForceKeyFrame`).
- **Controle de taxa:**
  - `bitrateMode: 'variable'` (o nosso) vira `eAVEncCommonRateControlMode_PeakConstrainedVBR` (L1748, conferido). O Blink manda **pico = 10× o alvo** (`video_encoder.cc` L318, conferido: "here we just set peak as 10 times").
  - `constant` vira CBR, ou o controle de taxa por software do Chromium em conteúdo "câmera".
  - Trocar só o bitrate em `configure` grava `CODECAPI_AVEncCommonMeanBitRate` ao vivo. O Blink drena o encoder (`Flush`) antes de aplicar (`CanReconfigure`, L895–907).
- **Perfis e nível:**
  - O MF anuncia Baseline, Main e High.
  - Teto H.264 de `{172 fps, 1920×1080}` e `{64 fps, 3840×2160}` com `kExpandMediaFoundationEncodingResolutions` (ligada). 1080p60 cabe.
  - O MFVEA **não grava o nível** no tipo de saída; a Microsoft documenta que, sem nível, "the encoder will select the encoding level".
  - O Blink só confere o tamanho do quadro contra o nível da string do codec.
  - **`avc1.42e02a` (Constrained Baseline 4.2) já é o codec de produção** (`webcodecs-codificador.ts`). O `avc1.640028` (High 4.0) da tarefa existe só no harness do D0 (`apps/desktop/d0/encoder.mjs`). Não há mudança de nível a fazer, e nenhum decoder de espectador muda.
- **Entrada de CPU** (L2145–2205, via subagente):
  - I420 para NV12 **na CPU** do processo de GPU, para um `MFCreateAlignedMemoryBuffer`.
  - O MFT sobe para a GPU por dentro.
  - A entrada por textura (SharedImage) exige `kMediaFoundationD3DVideoProcessing`, **desligada** na 152 (`CR/media/base/media_switches.cc` L1743, conferido).

**Electron 44.** É Chromium 152.0.7977.x ([releases.json](https://releases.electronjs.org/releases.json)). O [`feature_list.cc` do Electron v44.5.1](https://github.com/electron/electron/blob/v44.5.1/shell/browser/feature_list.cc) não toca em mídia, Media Foundation nem oclusão. `kMediaFoundationVideoEncodeAccelerator` vem ligada por padrão (L1747, conferido).

### 1.2 (b) Flags de Chromium: nenhuma ligada

| Flag | O que faz | Decisão |
|---|---|---|
| `--enable-features=MediaFoundationD3DVideoProcessing,WebRtcAllowWgcUsingTexture` | O único caminho de textura de ponta a ponta: WGC entrega SharedImage, e o MF a aceita. Exige Win11 24H2 e **não desenha o cursor** (comentário em `webrtc_features.cc`). Ligar só a segunda **piora**: o Blink faz readback no renderer (`video_encoder.cc` L1109, conferido) | **Não ligada.** É experimento para a validação humana (§6, passo 6) |
| `--force_high_performance_gpu` | Põe o processo de GPU do Chromium na placa dedicada | **Não.** Em notebook híbrido, compositor e encoder iriam disputar a placa com o jogo. A enumeração do MF segue a ordem do DXGI de qualquer jeito |
| `--disable-gpu-driver-bug-workarounds`, `--ignore-gpu-blocklist` | Tiram as proteções. Entre elas: NVIDIA ≤ 24.21.13.9858 sem encode H.264 (entrada 337), `disable_nv12_upload` em drivers NVIDIA específicos (453/454), SW BRC desligado em AMD (449) | **Nunca.** Trocariam uma GPU que funciona em software por uma que trava |
| `--disable-features=CalculateNativeWinOcclusion` | Evita que a janela coberta pelo jogo seja tratada como oculta | Fora do escopo do encode. A captura e o encoder não dependem da janela visível, e o app já tem `backgroundThrottling: false`. É risco de D4 (`estudo/3` §1, item 6) e entra na validação humana do D4 |

### 1.3 (c) Como saber em tempo de execução se é hardware

- O WebCodecs não expõe `encoderImplementation`. A spec manda não vazar hardware por `isConfigSupported` ([WebCodecs §7.9](https://www.w3.org/TR/webcodecs/)), mas o Chromium não esconde: a resposta vem da tabela de perfis do processo de GPU.
- `isConfigSupported(prefer-hardware)` diz se **há** MFT para a configuração. Não garante que a inicialização dê certo.
- O único sinal certo é **configurar com `prefer-hardware`**: se der certo, é hardware; se falhar, chega `error()`. É o que o app faz agora.
- Medi aqui (Chromium 151, headless, sem GPU): `configure({hardwareAcceleration: 'prefer-hardware'})` sem suporte chama `error` **de dentro do próprio `configure`**, de forma síncrona, com `OperationError: Encoder creation error.`. O código trata as duas formas, síncrona e assíncrona.
- Na máquina do dono, o painel *Media* do DevTools mostra `MediaFoundationVideoEncodeAccelerator (<nome do MFT>)` (MFVEA L596–598). É a confirmação humana.

### 1.4 O custo da captura: cópias GPU→CPU

O `getDisplayMedia` do Windows (`CR/content/browser/media/capture/desktop_capture_device.cc`) usa WGC para tela só a partir do Win11 24H2 (L265, conferido) e DXGI Desktop Duplication antes disso.

Os dois **mapeiam uma textura de staging na CPU** ([`wgc_capture_session.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/desktop_capture/win/wgc_capture_session.cc), `dxgi_texture_staging.cc`). Por quadro, no caminho padrão da 152:

| # | Onde | Operação | Bytes por quadro em 1080p |
|---|---|---|---|
| 1 | browser (captura) | GPU→CPU: `CopySubresourceRegion` para staging, `Map`, cópia | 8,3 MB (BGRA) |
| 2 | browser | BGRA→I420 na CPU (`libyuv::ARGBToI420`, L964, conferido) para a memória compartilhada | 3,1 MB |
| 3 | renderer | `MediaStreamTrackProcessor` → `VideoEncoder`: o `VideoFrame` aponta para a mesma memória compartilhada, **sem cópia** (`PrepareCpuFrame` devolve o quadro se for I420 de shmem do mesmo tamanho) | 0 |
| 4 | GPU (processo) | I420→NV12 na CPU, para o buffer do MF | 3,1 MB |
| 5 | GPU (placa) | CPU→GPU dentro do MFT; **encode no ASIC** (NVENC/VCN/QSV) | 3,1 MB pelo PCIe |
| 6 | renderer | `chunk.copyTo` para um `ArrayBuffer` (~25 KB), transferido sem cópia ao worker | ~25 KB |
| 7 | worker | uma cópia por sender (inerente ao spec; `complexidade.md` A2) | N × 25 KB |

Ordem de grandeza (conta, **não medição**): a 60 fps são ~500 MB/s de
readback, duas conversões de cor na CPU e ~190 MB/s de upload. Com o encode no
ASIC, isso passa a ser a maior parte do custo de CPU que sobra. Mesmo assim, é
um custo de memória e de conversão, não de codificação, e nenhuma fonte
primária dá o número em ms.

O `kZeroCopyDesktopCapture` (desligado, L906, conferido) só economizaria uma
cópia na CPU. O zero-copy de verdade é o par experimental da §1.2.

---

## 2. Decisão

### 2.1 O caminho pequeno, e por quê

- O WebCodecs **já** codifica na GPU no Windows (§1.1), inclusive na NVIDIA (que o WebRTC pula). Não havia encoder a trocar.
- O que faltava era a verdade e a reação:
  - com `no-preference`, uma GPU que falha vira OpenH264 calado (~1,2 núcleo a 1080p60, D0) e o console dizia "hardware";
  - um driver travado congelava a transmissão sem erro nenhum.
- Os quatro invariantes da R5 não mudam:
  - H.264, com o mesmo `avc1.42e02a`;
  - `motion` por padrão: o `VideoEncoderConfig` não passa `contentHint`, e o MF trata a falta dele como conteúdo "câmera", que é o equivalente;
  - `maintain-framerate` fica nos senders;
  - um encoder só para todos.

  Também não muda bitrate, modo de bitrate, nível nem degrau.

### 2.2 O helper nativo: atrás de um portão de medição

Constrói-se `tela-captura-win` **se e somente se** a validação humana (§6) mostrar as duas coisas:

1. O codificador está mesmo na GPU: `WebCodecs·hardware` e motor "Video Encode" > 0 no Gerenciador de Tarefas.
2. A queda de FPS do jogo com a transmissão passa de **3%** (meta do PLANO §1.2), ou a CPU do processo *browser* do Tela na bancada passa de **0,25 núcleo** (o custo da §1.4).

Antes do helper, vale testar o par experimental de flags (§6, passo 6). É uma
linha de comando e pode bastar.

Desenho, para quando o portão abrir. Espelha o `tela-captura` do Linux:

- **Captura:** `Windows.Graphics.Capture` (`Direct3D11CaptureFramePool::CreateFreeThreaded`, 2 buffers, `MinUpdateInterval` = 1/fps).
- **Conversão:** BGRA→NV12 por `ID3D11VideoProcessor` no mesmo `ID3D11Device` do MF, sem readback.
- **Encode:** MFT de hardware ativado com `MFT_ENUM_FLAG_HARDWARE` e `MFT_MESSAGE_SET_D3D_MANAGER` (`IMFDXGIDeviceManager`); `CODECAPI_AVLowLatencyMode`, Baseline, GOP infinito, `CODECAPI_AVEncVideoForceKeyFrame` sob pedido.
- **Saída:** Annex-B pelo mesmo protocolo de `pronto`/`quadro`/`stats`/`erro` e ordens `alvo`/`chave`/`atraso`/`parar`.
- **`--sondar`:** ativa o MFT e sai 0 ou 3.
- **Orquestração:** escolhido pelo `CodificadorComutavel` como o NVENC do Linux.
- **CI:** compilado no job `windows` do `desktop.yml`, como o addon WASAPI.

Zero cópia GPU→CPU, nenhuma conversão na CPU, um pool fixo de texturas.

---

## 3. O que mudou

| Arquivo | O quê |
|---|---|
| `apps/web/src/core/media/aceleracao-do-codificador.ts` (+ teste) | Política pura de GPU ou CPU: `prefer-hardware` quando a sonda diz que há (no app), senão o `no-preference` de sempre; queda para `prefer-software` quando a GPU morre ou trava; volta ao modo inicial depois de 30 s e depois de 60 s; na 3ª queda, software até o fim. Rótulo que só afirma o que sabe |
| `apps/web/src/core/media/vigia-do-encoder.ts` (+ teste) | Tempo entrada→saída num anel fixo de 16 posições (`Float64Array`), O(1), sem alocação. Acusa a trava: ≥ 30 quadros oferecidos **e** 2 s sem saída. Tela parada e primeiro IDR lento não contam |
| `apps/web/src/adapters/webcodecs-codificador.ts` (+ `webcodecs-codificador-gpu.test.ts`) | Usa os dois acima. `error` (inclusive o síncrono, dentro do `configure`) ou trava: fecha o encoder, cria outro em software **numa microtarefa**, com IDR no primeiro quadro, sem derrubar a transmissão. Erro já em software não recria na hora (sem laço). Um segundo `iniciar` fecha o encoder anterior, que antes ficava aberto |
| `apps/web/src/desktop/container.desktop.ts` | O app liga `preferirHardware`. A web e o dev sem Electron continuam em `no-preference` |
| `apps/web/src/react/use-media-stats.ts`, `routes/Broadcast.tsx` | CODIFICA mostra onde e quanto: `GPU · 3,1 ms` / `CPU · 14,2 ms`. Antes, `WebCodecs·software` era lido como **hardware** (a lista de software não casava), e `WebCodecs` sozinho também |
| `apps/web/src/core/media/diagnostico.ts` | O diagnóstico recusava o `·` dos rótulos do app e saía sem encoder |
| `e2e/bench/vigia-do-encoder.bench.mjs`, `e2e/bench/codificador-gpu.bench.mjs` | As bancadas da §5 |

**Por que lentidão não derruba para CPU.** Encoder de GPU lento é GPU
disputada pelo jogo. Mandar o trabalho para a CPU tiraria do jogo o que ele
mais precisa. A lentidão continua sendo o sinal `cpu` do transporte
(`encodeQueueSize > 2`), que leva a malha a descer o degrau: menos pixel, no
mesmo encoder.

---

## 4. Análise por quadro (o caminho escolhido)

| | Por quadro | Por espectador | Teto |
|---|---|---|---|
| Encode | 1 (ASIC da GPU) | **O(1) em N**: o "um encode" não muda | — |
| Nosso JS no renderer | O(1): o vigia guarda e busca no anel (a busca para no 1º pendente porque a saída vem em ordem; pior caso 16 posições), política em O(1), um `ArrayBuffer` do tamanho do quadro codificado (inerente: é transferido ao worker) | 0 | anel de 16 posições fixo |
| Worker | — | O(B) por sender (A2, <1% de um núcleo a N=50) | `FilaDeInjecao` em anel |
| Fila do encoder | descarta na entrada acima de 2 (`encodeQueueSize > 2`) | — | ≤ 3 quadros no Blink |
| Cópias | §1.4: 1 readback, 2 conversões de cor na CPU, 1 upload (do Chromium, não nossas) | 1 cópia de ~25 KB por sender | — |

**Alocação no regime (nosso código):**

- Por quadro, só o `ArrayBuffer` do quadro codificado.
- O `Map` de timestamps de antes alocava uma entrada por quadro; o anel não aloca nada.
- `VideoFrame.close()` é chamado em todos os caminhos de `codificar`: entregue, descartado por fila, por contrapressão, por trava ou com o encoder fechado.

**Pior caso de latência:**

- Em regime: fila do encoder ≤ 3 quadros (50 ms a 60 fps) mais o pipeline do MFT assíncrono (não medido; a validar) mais a contrapressão dos senders (2 quadros).
- Na falha: `error` reconstrói na hora (um IDR). A trava custa até 2 s de imagem parada, uma vez por queda; são no máximo 3 quedas por transmissão.

---

## 5. Estabilidade

| Situação | Comportamento |
|---|---|
| GPU recusa a configuração | `error` síncrono no `configure`, tratado: `aplicar` confere se o encoder ainda é o mesmo antes de marcar configurado. Software na microtarefa seguinte |
| TDR / GPU removida / driver reiniciado | `error` assíncrono. Software na hora, nova tentativa de GPU em 30 s e depois em 60 s; na 3ª queda, fica |
| Driver travado (sem erro) | Vigia: ≥ 30 quadros oferecidos e 2 s sem saída. Mesma queda, rótulo `GPU travou` |
| Erro com o software | Recria no próximo `configurar` (~1 s), como sempre foi; não entra em laço |
| Troca de degrau/resolução | `configure` com o novo tamanho; IDR. O bitrate só reconfigura com variação acima de 5%, porque cada `configure` drena o encoder (§1.1) |
| Troca de fonte | `trocarFonte` troca o leitor e pede IDR; o encoder e o modo continuam |
| Suspensão | O D4 encerra a transmissão; `parar` fecha o encoder e impede a microtarefa de recriar |
| Vazamentos | Todo `VideoFrame` é fechado; encoder substituído é fechado (`descartar`); o `error` de um encoder antigo é ignorado |

---

## 6. Medido aqui (Fedora 44, Ryzen 7 7435HS, RTX 4050, Chromium 151 headless, sem GPU)

**Comandos de verificação:**

- `pnpm turbo lint typecheck test build --concurrency=2`: 16 tarefas verdes. Na web, 1159 testes em 133 arquivos (28 novos); no desktop, 350.
- `pnpm depcruise`: sem violações (500 módulos).
- `pnpm exec eslint apps packages --no-warn-ignored`: limpo.

**Vigia contra o `Map` de antes** (`node e2e/bench/vigia-do-encoder.bench.mjs`; 10 min a 60 fps, descontada a linha de base do laço):

| | ns/quadro | bytes/quadro |
|---|---|---|
| Antes (`Map`) | 76–312 | 27–32 |
| Agora (`VigiaDoEncoder`) | 17–23 | 15–18 |

- As médias de ms/quadro são idênticas em todas as leituras, e não houve nenhuma trava falsa.
- O resto de bytes do anel é o *boxing* dos argumentos `double` na chamada, que a linha de base do laço também mostra; o anel não aloca.
- Em absoluto, as duas versões são desprezíveis: menos de 0,002% de um núcleo.

**CPU por processo** (`node e2e/bench/codificador-gpu.bench.mjs`, 1920×1080 a 60 fps, 15 s, descontada a fonte):

- O codificador do app ficou em 1,13–1,19 núcleo no renderer, a 60 fps e 7,7–8,4 ms/quadro, com o rótulo `WebCodecs·software`.
- Forçado a `prefer-software`, deu 1,21.
- O código anterior, servido pelo `pnpm dev` de `develop`, deu 1,34 núcleo a 11,2 ms/quadro.
- A diferença está dentro do ruído da máquina, que estava com carga média de 30 a 50 vindo de outras sessões.
- **No Linux nada muda de comportamento**: sem VA-API, a sonda diz "sem hardware", e o modo é o `no-preference` de antes.

**`e2e/um-encode.e2e.mjs` e `e2e/latencia.e2e.mjs`** (servidor desta árvore em :5183, mesmo signaling):

- O `um-encode` já **falhava antes da mudança** no critério de "≤ 3 quadros-chave em 30 s": 4 antes e 7 depois.
  - Instrumentei o `VideoEncoder` numa cópia temporária do e2e: **um encoder criado, zero erros, zero recriações**, e os IDRs coincidem com as trocas de degrau (720p ↔ 576p) que a carga da máquina provocou.
  - O mesmo e2e contra `develop` deu 21 quadros-chave.
  - Recepção, fluidez e reconexão passaram.
- O `latencia` passou nas duas rodadas, antes e depois. Os números absolutos da segunda rodada refletem a carga (o mesh também subiu de 50 para 293 ms).

**Não mexi** em orçamento, malha nem degrau, então `malhas.sim.mjs` não se
aplica.

---

## 7. Não verificado: validação humana no Windows

Máquina do dono, Windows 11, GPU dedicada; `pnpm --filter @tela/desktop dev:app` ou o instalador do CI.

1. **O app codifica na GPU.**
   - Transmitir uma TELA em 1080p60 e abrir o console da transmissão. CODIFICA deve mostrar `GPU · x ms`, e o painel NO AR, `WebCodecs·hardware`.
   - No Gerenciador de Tarefas → Desempenho → GPU, o gráfico "Video Encode" (ou "Codificação de vídeo") deve ficar acima de 0 durante a transmissão.
   - Com DevTools no app (Ctrl+Shift+I no dev), a aba *Media* deve mostrar `MediaFoundationVideoEncodeAccelerator (NVIDIA…/AMD…/Intel…)`.
2. **1080p60 sustentado.**
   - O console deve mostrar SAI DO ENCODER `1920×1080` e QUADROS ~60 por 5 min, com 1 espectador web.
   - Anotar o `ms` de CODIFICA. Acima de 16,7 ms ele acende alerta, mas num MFT assíncrono isso pode ser latência de pipeline e não falta de vazão: o que decide é QUADROS ≈ 60.
3. **FPS do jogo.**
   - Mesmo jogo, mesma cena, em tela cheia sem bordas, com PresentMon ou CapFrameX: (a) sem o Tela; (b) com o Tela transmitindo para 1 espectador; (c) para 3 espectadores. 60 s cada, 3 repetições.
   - Meta: queda ≤ 3% em (b) e (c), e (c) ≈ (b) (ADR 0029).
4. **CPU por processo.**
   - Com o `pnpm dev` rodando: `set CHROME=…\chrome.exe`, `set HEADLESS=0`, `node e2e/bench/codificador-gpu.bench.mjs --segundos=20`.
   - Esperado: em "produto", `WebCodecs·hardware` e núcleos do renderer muito abaixo de "cpu".
   - A coluna **browser** é a captura (§1.4): é o número do portão §2.2.
5. **Queda e volta.**
   - Com a transmissão no ar, derrubar o encoder da GPU: desativar e reativar a GPU no Gerenciador de Dispositivos (só em máquina com outra saída de vídeo). Win+Ctrl+Shift+B reinicia o driver de vídeo, mas pode não invalidar o encoder; se nada mudar, use o Gerenciador.
   - Esperado: o espectador congela por menos de 2 s; CODIFICA vira `CPU`, com o rótulo `WebCodecs·software·GPU caiu`; em ~30 s volta a `GPU`. A transmissão não cai.
6. **(Opcional, antes de qualquer helper nativo)** Abrir o app com `--enable-features=MediaFoundationD3DVideoProcessing,WebRtcAllowWgcUsingTexture` (Win11 24H2) e repetir os passos 3 e 4.
   - Se o FPS do jogo melhorar de forma mensurável, é a evidência a favor do caminho de textura.
   - O cursor não aparece nesse modo (limitação do Chromium).
7. **Espectadores.** Firefox e Safari assistindo ao fluxo vindo do MFT da NVIDIA, da AMD e da Intel (Baseline do MF, não o Constrained Baseline do OpenH264): imagem, sem quadro verde, fps estável.
8. **Notebook híbrido.** Jogo na dGPU e Tela no padrão do Windows. Anotar em qual adaptador aparece o "Video Encode" e o FPS do jogo.

---

## 8. Decisões fora dos documentos

- **Nenhuma flag de Chromium no main** (§1.2). O par de flags de textura fica como experimento manual.
- **Política de volta:** 30 s, depois 60 s, e no máximo 2 voltas. É custo de CPU contra risco de congelar de novo; os números são escolha minha e não foram medidos.
- **Trava:** 2 s e 30 quadros. Mais curto acusaria o primeiro IDR de um MFT recém-criado (centenas de ms, não medido); mais longo deixaria a imagem parada por mais tempo.
- **A web continua em `no-preference`.** Ganhou o vigia e a queda, mas não o `prefer-hardware`, para não mudar o que hoje funciona. Ligá-lo também na web daria o mesmo rótulo honesto, e é o próximo passo natural depois da validação do §7.
- **`WebCodecs` sem sufixo é "desconhecido"** no console, não "hardware".

## 9. Dúvidas

- **Nível do SPS:** o MF escolhe o nível (§1.1). Para 1080p60 deve sair ≥ 4.2, mas não foi conferido; o passo 7 cobre o efeito no espectador.
- **Pico de 10× no VBR** do Blink (§1.1): os IDRs do MFT podem ser maiores que os do NVENC do Linux (VBV de 2 quadros). Medir o tamanho do IDR no passo 2: aparece como quadros-chave no `inbound-rtp` do espectador e bytes no `outbound-rtp`. Trocar para `constant` mexe no controle de taxa e pede ADR (0017/0018).
- **`contentHint` no modo nitidez:** o `VideoEncoderConfig` não leva `contentHint`, então o MF sempre vê conteúdo "câmera", inclusive no modo `nitidez` (ADR 0015). É uma lacuna anterior a este trabalho; não mexi.
- **Custo real da §1.4** (readback + duas conversões): estimado, não medido.

## Fontes

- Chromium 152.0.7977.130:
  - [`video_encoder.cc`](https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/modules/webcodecs/video_encoder.cc)
  - [`video_encoder_fallback.cc`](https://github.com/chromium/chromium/blob/152.0.7977.130/media/video/video_encoder_fallback.cc)
  - [`media_foundation_video_encode_accelerator_win.cc`](https://github.com/chromium/chromium/blob/152.0.7977.130/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc)
  - [`mf_video_encoder_util.cc`](https://github.com/chromium/chromium/blob/152.0.7977.130/media/gpu/windows/mf_video_encoder_util.cc)
  - [`media_switches.cc`](https://github.com/chromium/chromium/blob/152.0.7977.130/media/base/media_switches.cc)
  - [`desktop_capture_device.cc`](https://github.com/chromium/chromium/blob/152.0.7977.130/content/browser/media/capture/desktop_capture_device.cc)
  - [`gpu_driver_bug_list.json`](https://github.com/chromium/chromium/blob/152.0.7977.130/gpu/config/gpu_driver_bug_list.json)
- WebRTC: [`wgc_capture_session.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/desktop_capture/win/wgc_capture_session.cc)
- [Revert do CBP no H.264 por hardware (crbug 1088650)](https://groups.google.com/a/chromium.org/g/feature-media-reviews/c/t7DPtMGsK2Q)
- Microsoft, [H.264 Video Encoder (Media Foundation)](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder)
- W3C, [WebCodecs](https://www.w3.org/TR/webcodecs/)
- Electron: [releases.json](https://releases.electronjs.org/releases.json), [`feature_list.cc` v44.5.1](https://github.com/electron/electron/blob/v44.5.1/shell/browser/feature_list.cc)
