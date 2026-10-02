# Estudo 3 — Latência, lado do espectador, consumo do host/desktop, infra e metodologia de medição

**Data:** 2026-10-02 · **Escopo:** pesquisa com medição. Nenhum arquivo de produto foi alterado. Harness estendido: `e2e/bench/estudo-decode-espectador.mjs`.
**Convenção de confiança:** **[M]** medido aqui, **[D]** documentação primária lida nesta sessão (URL em Referências), **[L]** de memória/literatura secundária — verificar antes de decidir, **[H]** hipótese minha.

> **Aviso sobre as medições.** A máquina (Ryzen 7 7435HS, 16 threads, Linux 7.2.7, Chromium headless do Playwright 1.62.1/`chromium_headless_shell-1234`) era COMPARTILHADA com outros agentes durante a coleta: `loadavg` observado entre 5 e **308**. Isso inflou a variância (um mesmo cenário foi de 0,29 a 0,48 núcleo). Por isso as tabelas trazem faixa e mediana, só entram execuções em que o degrau pedido chegou ao espectador, e as comparações A/B foram **intercaladas**. Headless = SwiftShader sem GPU, encode OpenH264 e decode FFmpeg em software: **os números são o piso de custo do caminho de software, não o caminho de hardware** (AGENTS.md: o resto é de humano).

---

## 0. Resumo executivo

1. **A latência ponta a ponta do produto ainda não é medível por código.** O `captureTime` do `requestVideoFrameCallback` vem **vazio em 100% dos quadros** (0 de 852) porque o SDP negociado **não traz `abs-capture-time`** [M]; o HUD cai sempre para a origem `recepcao` (que subestima). Além disso, os campos de lado do transmissor de `googTimingFrameInfo` saem lixo no "um encode" (valores -3…-1) [M]. Medir primeiro é a proposta nº 1.
2. **A fatia que o produto escolhe é o jitter buffer, e ela é medível e barata de cortar numa rede calma.** Em loopback, com piso de `jitterBufferTarget` 0 e 20 ms o buffer medido foi **8 ms**; com 80 ms, **59 ms** (+50 ms) [M]. O governador tem piso de 40 ms (`JITTER_MINIMO_MS`) e partida em 60 ms: em rede calma há **~10 a 30 ms** a recuperar, ao preço de risco de congelamento que só `tc netem` com jitter real quantifica.
3. **Decodificar custa pouco; o que pode custar é o que se põe por cima do vídeo.** Decode em software: **1,7 ms/quadro a 720p60 e 2,6–3,4 ms a 1080p60**; 0,30 e 0,5–0,6 núcleo por aba [M]. O espectador atual **não** põe CRT/filtro sobre o vídeo (correto). Medi o que aconteceria se alguém pusesse: scanlines estáticas +0,1 núcleo; **`backdrop-filter: blur` sobre o vídeo 0,29 → ~1,2 núcleo (≈4×)** em raster por software [M]. Proposta: trava automática (teste de CSS) mais "modo leve".
4. **Possível lacuna no desktop:** a ociosidade de 5 fps é aplicada por `track.applyConstraints` (`broadcast-session.ts:1615`). No caminho nativo a trilha é uma "trilha-fantasma" (canvas); nada em `apps/web/src/desktop/` repassa o fps ocioso a `tela-captura` [L/H, a validar medindo CPU do processo nativo sem espectador].
5. **Infra cabe folgadamente no plano grátis em escala de amigos.** Uma sala de 50 entradas custa ~130 requisições de DO (mensagens de entrada contam 20:1) e, por hipótese, ~100 GB-s [D+H]. O teto realista do plano grátis é a duração (13 000 GB-s/dia ⇒ ~130 salas de 50/dia), não as requisições. **TURN é o risco de custo:** 1080p60 a 12 Mbps relayado são ~5,4 GB/h por espectador; 1 000 GB grátis/mês ≈ **185 espectador-horas relayadas** [D+conta].
6. **Bundle:** o espectador baixa `index` = 494,6 kB (152 kB gzip) + CSS 9,3 kB gzip, e **não** baixa three.js/GLB (lazy, só abertura/vitrine) [M]. Mas o código de transmissão vai junto (a rota `Viewer` não é `lazy`).

---

## 1. Orçamento de latência glass-to-glass, por estágio

### 1.1 Estado atual do código

| Estágio | Onde | O que o código decide |
|---|---|---|
| Captura | `getDisplayMedia` (web) · `tela-captura.c` (Linux nativo) | `contentHint='motion'`, 60 fps pedidos, `IDLE_CAPTURE_FPS=5` (`broadcast-session.ts:282`) |
| Encode | WebCodecs/OpenH264 ou NVENC (`codificador-*.ts`), "um encode, N envios" | CBR/VBV 4 quadros no NVENC (D0c) |
| Pacotização/pacer | libwebrtc (não controlamos) | IDR coalescido por `janelaDeChaveMs` (`fila-de-injecao.ts`) |
| Rede | mesh P2P, TURN opcional | `x-google-start-bitrate` no SDP recebido (ADR 0016) |
| Jitter buffer | `PeerLink.setJitterAlvo` (`peer-link.ts:233`), `JitterGovernor` | seta **`playoutDelayHint` (s) e `jitterBufferTarget` (ms) juntos, só no vídeo**; partida 60 ms, piso 40, teto 240; sobe 40, desce 10 a cada 12 amostras limpas |
| Decode | Chromium | nada (campo `decoderImplementation` não é exposto no caminho real, ADR 0016) |
| Render | `<video>` + `useFrameLatency` (rVFC) | `autoPlay playsInline`, sem overlay; `transform: scale()` sempre aplicado |

### 1.2 Números de literatura e de medição

| Estágio | Faixa típica | Fonte / confiança | Nosso caso |
|---|---|---|---|
| Captura WGC / DXGI DD | 0 a 1 vsync de espera (média ~8 ms a 60 Hz) + cópia GPU (<1 ms). WGC expõe `MinUpdateInterval` e `IsBorderRequired`/`IsCursorCaptureEnabled` [D]; quadros do frame pool chegam já compostos pelo DWM | [D]+[L] | Windows ainda sem caminho nativo; o Chromium usa WGC para tela [L] |
| Captura PipeWire (Mutter) | **~40 q/s num monitor de 165 Hz**, de qualquer jeito testado: o intervalo médio sobe de 16,7 para 25 ms (+~4 ms de defasagem média e juder) | [M] em D0c, issues mutter#4214 | captura de JANELA não teria o limite [L] |
| Encode NVENC | **2,5 ms/quadro 1080p** | [M] D0c | |
| Encode OpenH264 SW | ~1,2 núcleo a 1080p60 (D0); a ponte WebCodecs `copyTo` soma 5–20 ms | [M] D0/D0c | |
| Pacer + pacotização | quadro P ~25 KB: com pacing ~2,5× o bitrate (30 Mbps) são ~7 ms; **IDR 150–300 KB: 40–80 ms** de escoamento, ×N cópias | [L] para o fator 2,5; conta [M] no `complexidade.md` §C4 | a janela ∝ N (`janelaDeChaveMs`) já limita o custo |
| Rede | P2P LAN 1–5 ms; BR residencial 10–40 ms só ida | [L] | `rttMs/2` no HUD |
| Jitter buffer | libwebrtc "~100–125 ms em rede calma" (blog); Stadia **58 ms@720p, 45 ms@1080p, 35 ms@4K** (Carrascosa & Bellalta) | [L] blog / [D] arXiv | **medido aqui em loopback:** 8–27 ms (ver 1.3) |
| Decode | SW 1,7–3,4 ms [M]; HW 1–4 ms [L] | | |
| Decode→render | **11–19 ms** (`render_time − decode_finish` em `googTimingFrameInfo`) | [M] | atraso de render do `VCMTiming` (10 ms por padrão [L]) + espera de vsync |
| Display | 0–16,7 ms (média 8,3 ms) a 60 Hz; 3,5 ms a 144 Hz | aritmética | não controlável |

Soma indicativa (rede calma, HW em ambas as pontas, monitor 60 Hz): captura ~8 + encode ~3 + pacer ~4 + rede ~10–25 + jitter 20–60 + decode ~2 + render 11–19 + display ~8 = **~70–130 ms**. Para comparação, a literatura de Moonlight/Sunshine fala em 70–100 ms otimizados [L, página de blog; não citar como número do produto].

### 1.3 Medição: o que o espectador mostra por dentro **[M]**

Mesmo harness, 720p60, um espectador, loopback (rede sem jitter, então `jitterBufferMinimumDelay` ≈ 12 ms é o mínimo que a "rede" exige):

| Piso `jitterBufferTarget` (e `playoutDelayHint`) | `jitterBufferDelay`/quadro | alvo do estimador | `totalProcessingDelay`/quadro | congel./descartes |
|---|---|---|---|---|
| 0 ms (2ª passada) | 8,4 ms | 12,0 | 10,7 | 0 / 0 |
| 20 ms | 7,7 ms | 11,9 | 10,2 | 0 / 0 |
| 40 ms (nosso piso) | 19,2 ms | 26,0 | 21,5 | 0 / 0 |
| 80 ms | **59,3 ms** | 66,8 | 62,2 | 0 / 0 (58 fps) |

Ressalvas: 24 amostras de `googTimingFrameInfo` por linha, uma passada só, 4 s de acomodação; a primeira passada em 0 deu 18 ms porque o buffer encolhe devagar (hipótese [H]: efeito de histerese do estimador); a máquina estava carregada. **Direção segura, valores precisam de repetição (seção 6).** A leitura que se sustenta: o piso funciona como piso (59 ms para 80 ms pedido ≈ piso menos o que o buffer mede de forma diferente do alvo), e **abaixo de ~20 ms o piso não é mais a restrição em rede sem jitter**.

Medição de quadro a quadro com rVFC (852 quadros, 720p60): `receiveTime→expectedDisplayTime` **p50 40,3 ms / p95 53,9 ms**; `processingDuration` p50 1,7 ms; intervalo de exibição p50 16,7 ms, **p95 33,3 ms** (um quadro perdido em ~5%, headless sem vsync real). `captureTime`: ausente.

Extensões de cabeçalho de vídeo realmente negociadas [M]: `toffset, abs-send-time, video-orientation, transport-wide-cc-02, playout-delay, video-content-type, video-timing, color-space, mid, rid, repaired-rid`. **Sem `abs-capture-time`.** Com `playout-delay` oferecido, o transmissor poderia carimbar min/max por quadro, que "vence o estimador do receptor" [L, blog], mas a API do Chromium não expõe isso ao transmissor [H].

### 1.4 Onde cortar dezenas de ms

| # | Corte | Ganho esperado | Custo / risco | Experimento |
|---|---|---|---|---|
| a | Piso do jitter buffer: partida 60→40 e piso 40→20 em links classificados como calmos (RTT estável, perda 0 por 30 s), com a mesma subida rápida de hoje | **10–30 ms** (19→8 ms em loopback [M]; Stadia opera 45 ms em 1080p) | Volta o ciclo "quadro incompleto → PLI → IDR 6–10× maior" (Discord) se o jitter for real; mitigação já existe: `JitterGovernor` sobe 40 ms por congelamento | `tc netem delay 20ms 5ms distribution normal loss 0.5%` em dois Chromes reais, 10 repetições por piso {0,20,40,60}; critério: congelamentos/min e PLI/min não sobem acima do IC do piso 40 |
| b | Captura de janela (não monitor) no Linux/Mutter | ~4 ms de defasagem + 40→60 q/s | Troca de UX (portal de janela) | contar `framesDecoded/s` no espectador por 60 s |
| c | `playout-delay` min=max=0 do transmissor ("render imediato" no `VCMTiming` [L]) | até ~11 ms (o `decode→render` medido) | Fora da API pública [H]; só com Encoded Transform/SDP; risco alto | só pesquisar: ler `modules/video_coding/timing/timing.cc` no libwebrtc que o Electron 44 usa |
| d | Monitor a ≥120 Hz no espectador | 4–5 ms | não controlável | — |
| e | IDR que não bloqueia o pacer | até 40–80 ms nos picos | já mitigado (janela ∝ N, teto por sender) | `P95` de `intervaloP95` do rVFC com `tc loss 2%` |

**Honestidade:** o corte (a) é o único que muda um número observável com código nosso; é "latência paga sem necessidade" (como a própria ADR 0016 diz) só enquanto a rede for calma.

---

## 2. Lado do espectador

### 2.1 Decodificação por hardware, H.264 1080p60

Nível 4.2 (522 240 MB/s) cobre 1080p60 (489 600 MB/s); 4.1 já cobre 1080p30 e o 1080p60 só em perfis/níveis altos — por isso a ADR 0020 deixou de reescrever o nível por padrão.

| Plataforma | Decoder do WebRTC no navegador | Confiança |
|---|---|---|
| Windows (Chrome/Edge) | D3D11VA via `D3D11VideoDecoder`, qualquer GPU dos últimos ~10 anos | [L] |
| macOS / iOS (Chrome, Safari) | VideoToolbox | [L] |
| Android | MediaCodec (nomes de driver variam: `OMX.qcom…`, `c2.qti…` — o HUD já trata, `use-media-stats.ts`) | [L] |
| Linux Intel/AMD | VA-API, ligado por padrão nas versões recentes (uma fonte menciona Chrome 152 "sem flags"; é fonte de baixa autoridade) | [L], validar |
| Linux NVIDIA | VA-API da NVIDIA só decodifica via driver comunitário; na prática **software** | [M-indireto] D0c: "VA-API da NVIDIA só decodifica" |
| Firefox desktop | H.264 em WebRTC passa por OpenH264/plataforma; a combinação por SO varia | [L] fraco |

`decoderImplementation` e `powerEfficientDecoder` **não aparecem** no `getStats()` do espectador no caminho real (ADR 0016, item 2) e também vieram `undefined` aqui em todas as execuções [M]; só `chrome://webrtc-internals` e `chrome://media-internals` dizem. **Proposta:** perguntar `MediaCapabilities.decodingInfo({type:'webrtc', video:{contentType:'video/h264;profile-level-id=64002a', width:1920, height:1080, framerate:60, bitrate:12e6}})` antes de ligar o espectador: devolve `powerEfficient` e `smooth` sem depender do stat. Custo: ~20 linhas atrás de uma port; ganho: o HUD passa a dizer "decode em software" (hoje `—`). Qualidade da API: [D] (spec Media Capabilities, não lida por inteiro nesta sessão: confiança média).

### 2.2 Caminho de render e o hook `useFrameLatency`

- `<video>` com `srcObject` é o caminho certo: o Chromium compõe o quadro do decoder sem passar pelo JS, e `canvas`/WebGL exigiria `VideoFrame`/`texImage2D` por quadro (cópia GPU→GPU na melhor hipótese, e perderia a promoção a overlay). A única vantagem do canvas seria o `desynchronized:true` [L] — não existe equivalente em `<video>`. **Recomendação: manter `<video>`.**
- `requestVideoFrameCallback` [D web.dev]: dispara no menor entre a taxa do vídeo e a do navegador; pode vir **1 vsync atrasado** em relação ao render; fornece `expectedDisplayTime`, `processingDuration`, e (remoto) `captureTime`/`receiveTime`/`rtpTimestamp`. O adaptador já trata o caso ausente (`browser-frame-timing.ts`).
- Custo medido da página do espectador (CDP `Performance.getMetrics`, 720p60, 20 s) [M]: **tarefas da thread principal 25–37 ms/s (≈2,5–3,7% de um núcleo)**: script 4,5–10 ms/s (inclui o callback do rVFC a 60 Hz e o `setState` de 1 Hz), **recálculo de estilo 5–8 ms/s**, layout 0,1–0,3 ms/s. O estilo é o suspeito: 1 Hz de re-render não deveria custar 5–8 ms/s [H: algo invalida estilo no HUD ou no `transition-transform`/`opacity`]. Investigar com um trace (`chrome://tracing`, categoria `blink,devtools.timeline`) — ganho pequeno (≤0,5% de núcleo), prioridade baixa.
- A taxa de atualização React (1 Hz via `useMediaStats`) está correta; o comentário em `Viewer.tsx` ("não 60 Hz") bate com o medido: nenhum custo de layout visível.

### 2.3 CRT, filtros e animações sobre o vídeo — "modo leve"

**Estado do código** (`EfeitosTv.tsx`, `globals.css:333`): `VidroCrt` (scanlines `repeating-linear-gradient` + vinheta `radial-gradient`, `position:fixed`, estático) **não é montado na rota com imagem** — só na sala de espera e na entrada de apelido (`Viewer.tsx`: "o vídeo do jogo NUNCA leva scanline"). `EstaticaTroca` e `CanalFlash` pertencem à troca de canal da home. O comentário em `AudioUnlock.tsx` já proíbe `backdrop-blur`. Animações contínuas: apenas o LED de 8 px (`.led-pisca`), pausado em aba oculta (`data-aba="oculta"`) e sob `prefers-reduced-motion`. **O espectador, como está, já é "modo leve".**

**Medição do que NÃO se deve fazer** [M] (cenário A/B intercalado, 720p60, mesmo host; overlay injetado depois do aquecimento; raster por software, então os valores absolutos são pessimistas para GPU):

| Overlay sobre o `<video>` | núcleos da árvore do navegador (3 rep.) | mediana | tarefas da thread principal (ms/s) |
|---|---|---|---|
| nenhum | 0,48 · 0,33 · 0,29 | **0,33** | 24,9–36,9 |
| `.crt-vidro` (scanlines+vinheta estáticas) | 0,54 · 0,44 · 0,42 | **0,44** (+0,1) | 32,9–35,5 |
| `backdrop-filter: blur(8px)` | 1,20 · 1,21 (1 rep. perdida: degrau caiu) | **~1,2 (≈ +0,9)** | 17–22 |

Leitura: o custo mora no **processo de GPU/compositor**, não na thread principal (a thread principal até diminui). Camada estática vira textura cacheada e custa pouco; **filtro que lê o vídeo atrás (`backdrop-filter`, `filter`, `mix-blend-mode`) obriga a recompor e re-rasterizar a cada quadro**, e com GPU real isso é energia e temperatura, não só CPU [H: com GPU o custo cai muito, mas não a zero; um jogo rodando no mesmo aparelho do espectador no celular/notebook é o caso ruim]. Também desabilita a promoção do vídeo a overlay de hardware (economia de bateria) [L].

**Proposta (modo leve = garantia, não botão):**
1. Teste automatizado que falha se `backdrop-filter`, `filter:`, `mix-blend-mode`, `will-change: filter` ou animação infinita aparecerem em qualquer seletor alcançável pela rota `Viewer` com imagem (varredura de `globals.css` + `className` literais). Custo: ~40 linhas. Ganho: impede a regressão de 4× em custo de espectador. **Risco: nulo.**
2. `@media (prefers-reduced-motion)` e `prefers-contrast` já existem; acrescentar `data-leve` no `<html>` quando `navigator.getBattery().charging===false` ou `deviceMemory<=4` [L] só como opcional — sem ganho medido, não priorizar.
3. Esconder a barra com `visibility:hidden` além de `opacity:0` depois do `transition` (hoje só opacidade): evita camada composta ociosa. Ganho não medido [H], risco baixo.

### 2.4 Memória e energia do espectador

Árvore inteira do Chromium headless com uma aba: **577–585 MiB (720p) e 603–614 MiB (1080p)** de RSS somado [M]. RSS soma páginas compartilhadas entre processos e superestima; para a decisão real use PSS (`/proc/<pid>/smaps_rollup`) ou `chrome://memory-internals`. A diferença 720→1080p é ~+30 MiB (buffers de decode). Energia: não medida (RAPL exige root neste kernel: `energy_uj` deu `Permissão negada`, ver 3.4).

### 2.5 Bundle e primeiro carregamento **[M]**

`pnpm --filter @tela/web build` equivalente (`vite build --outDir <tmp> --sourcemap false`, Vite 7.3.6, 243 módulos, 2,5 s):

| Arquivo | bytes | gzip -9 |
|---|---|---|
| `index-*.js` (todas as rotas) | 494 633 | **151 312** |
| `index-*.css` | 42 911 | 9 336 |
| `crt-modelo-*.js` (three.js + cena; lazy) | 606 762 | 152 777 |
| `three-crt-stage-*.js` (lazy) | 7 324 | 3 498 |
| `three-crt-vitrine-*.js` (lazy) | 7 203 | 3 655 |
| `injecao-worker-*.js` | 2 382 | 1 076 |
| `tela-crt.glb` (público; lazy) | 212 968 | n/d |
| `index.html` | 4 566 | 2 070 |

- Quem abre `/<canal>` baixa `index` + CSS ≈ **161 kB gzip**; **não** baixa `crt-modelo` (importado só por `abrirPalcoAbertura`/`abrirVitrineCrt` em `container.ts:233,248`). Correto.
- O que sobra: `App.tsx` importa `Broadcast`, `Home`, `Recover` estaticamente; o espectador carrega `BroadcastSession`, `encode-once-transport`, malhas etc. **Proposta:** `React.lazy` nas rotas `Broadcast`/`Home`/`Recover` (o `Viewer` fica no chunk principal). Ganho **estimado [H] 30–45% do `index`** (~45–70 kB gzip) — o número exato exige um build com a mudança, **não medido**. Ganho em tempo de carga: ~0,2–0,4 s em 3G rápido [conta: 60 kB ÷ 200 kB/s]; irrelevante em banda doméstica. Prioridade baixa. Risco: o `Broadcast` passa a ter um estado de carregamento; no Electron é local, sem efeito.
- `index.html` faz `preconnect` para Google Fonts (CSS e fontes externas): uma dependência de terceiro no primeiro pintar e um vazamento de IP do espectador para o Google; auto-hospedar as fontes elimina os dois (ganho: 1 RTT bloqueante + privacidade; risco: nenhum). [H sobre o tempo; o fato é visível no HTML.]
- O desktop usa `vite.desktop.config.ts` (build separado, `dist-desktop/`); o tamanho do bundle local é irrelevante comparado ao Chromium embutido (~100+ MB).

---

## 3. Consumo do host / desktop

### 3.1 Pegada do Electron

Modelo de processos [D]: principal (Node), **um renderer por janela**, processo de GPU e utilitários (rede) do Chromium, mais, no nosso caso, o filho `tela-captura` (nativo) e o worker de injeção (`injecao-worker`). O D0 mediu **770–850 MB com o servidor de desenvolvimento** (módulos sem empacotar) contra o alvo de ≤ 600 MB do PLANO; o próprio relatório pede refazer com o pacote final — **ainda não foi refeito**. Procedimento: `app.getAppMetrics()` (já previsto no PLANO §296) agrupando por `type` (Browser, Tab, GPU, Utility) e **PSS**, não RSS; 5 medições de 60 s após 30 s de aquecimento, janela visível e oculta.

Flags e opções relevantes:

| Item | Estado | Comentário |
|---|---|---|
| `backgroundThrottling:false` (`main.ts:185`, `d0/*.mjs`) | ligado | [D Electron] mantém timers/rAF em janela oculta; custo: a página não sabe que sumiu (por isso `avisarVisibilidade`) e o renderer escondido continua rodando 60 Hz de rAF/animações — as animações CSS já pausam por `data-aba="oculta"` |
| Oclusão no Windows | **não tratada** | Em Windows o Chromium calcula oclusão nativa de janela e pode tratar a janela atrás de um jogo em tela cheia como oculta, parando `requestAnimationFrame`/timers mesmo com `backgroundThrottling:false`. A defesa conhecida é `disable-features=CalculateNativeWinOcclusion` (e/ou `disable-backgrounding-occluded-windows`). **[L]; é o risco funcional nº 1 do Windows**: o jogo COBRE a janela do Tela por definição. Experimento: Windows 11, jogo em borderless, `visibilitychange`/`rAF` logado na página + FPS recebido por um espectador; com e sem a flag |
| `enableBlinkFeatures: RTCEncodedFrameSetMetadata` | ligado | necessário ao "um encode" |
| `--enable-features=VaapiVideoEncoder` etc. | só no `d0/main.mjs` (sondagem) | o produto usa NVENC fora do Chromium (D0c) |
| `app.disableHardwareAcceleration()` | não usar | o preview e o WebGL da abertura dependem da GPU |
| `Menu.setApplicationMenu(null)` | verificar | [D Electron performance] economiza inicialização; sem custo |

### 3.2 Caminhos de cópia zero

- **Windows (a construir):** WGC → `ID3D11Texture2D` → conversão RGB→NV12 no GPU (D3D11 Video Processor) → encoder via Media Foundation (NVENC/AMF/QSV) com `IMFDXGIDeviceManager`, sem leitura para a CPU [L; padrão dos hosts Sunshine/Apollo — ver as variantes citadas na pesquisa]. Alternativa sem código nativo: o `getDisplayMedia` do Chromium usa WGC e entrega `VideoFrame` apoiados em GPU, e o `VideoEncoder` com `hardwareAcceleration:'prefer-hardware'` roda no MFT; o D0c mostra que o gargalo do Linux era o `copyTo` de 5–20 ms, **não confirmado para Windows** [H]. **Experimento antes de construir:** Windows com NVIDIA/AMD, `WebCodecs` em 1080p60, Gerenciador de Tarefas → motor GPU "Video Encode" > 0 (prova de HW) e PresentMon no jogo; se o custo no FPS do jogo ≤ 3% (meta do PLANO), **não construir o caminho nativo no Windows**.
- **Linux (feito):** PipeWire DMA-BUF → `glupload` → `glcolorscale` → NV12 → `nvh264enc`: **0,054–0,070 núcleo** e ~0 a mais no gnome-shell [M, D0c], contra ~1,2 núcleo do OpenH264. A meta de ≤ 0,5 núcleo está cumprida em ordem de grandeza.

### 3.3 Captura ociosa

`IDLE_CAPTURE_FPS = 5` com 10 s de graça (`broadcast-session.ts:282, 1591–1598`), via `track.applyConstraints` preservando `width/height/resizeMode`. **No caminho nativo** o `CodificadorExterno` manda `alvo L A fps bps` ao processo (`codificador-externo.ts:86`), mas a trilha que a sessão vê é a fantasma (`trilha-fantasma.ts`); **`grep applyConstraints|frameRate|ocios` em `apps/web/src/desktop/` não acha nada** (só `captura-desktop.ts:78`, `fps: options.frameRate`) [M-grep]. Logo, **ociosidade em 5 fps provavelmente não chega ao `tela-captura`** [H]. Custo se verdadeiro: pequeno em CPU (0,06 núcleo + 0,1 de GPU/compositor, medidos em D0c) mas é energia desperdiçada nas horas em que ninguém assiste. Mudar `fps` no `alvo` **recicla o pipeline e gera IDR** (`mudouTamanho` inclui `fps`), então a troca precisa da mesma graça de 10 s. **Validação:** transmitir no desktop sem espectadores por 2 min; `pidstat -p $(pgrep tela-captura) 5` e `nvidia-smi dmon -s u` (coluna `enc`): se o consumo é igual ao com espectador, a lacuna existe.

### 3.4 Metodologia: FPS do jogo e energia

| O quê | Windows | Linux |
|---|---|---|
| FPS/frame time do jogo | **PresentMon** 2.x: `PresentMon.exe --process_name Jogo.exe --output_file x.csv --timed 120 --terminate_after_timed`; colunas de tempo entre presentes e tempo até exibido; deriva-se FPS médio, **1% low** e **P99 do frame time**. Overhead do próprio PresentMon é pequeno (ETW) mas não nulo: rodar em TODAS as condições. [L sobre nomes de coluna; ver README-ConsoleApplication.md do repositório, a página principal não os lista] | **MangoHud** com `MANGOHUD_CONFIG=output_folder=...,log_interval=0,autostart_log=...` e `--dlsym` quando necessário; planilha por log |
| Energia do pacote | **Windows Energy Estimation Engine** ("Power usage"/`powercfg /srumutil` por processo) é **estimativa**, não medida [L]; para medida real: wattímetro de tomada ou PCAT (hardware). Intel Power Gadget está descontinuado [L] | **RAPL** via `perf stat -a -e power/energy-pkg/ -- sleep 60` ou `/sys/class/powercap/intel-rapl:0/energy_uj`: **neste kernel dá `Permissão negada`** [M] (mitigação do Platypus; requer root ou `chmod`/capabilities). GPU NVIDIA: `nvidia-smi --query-gpu=power.draw,utilization.encoder --format=csv -lms 500` |
| CPU por processo | `typeperf`/`Get-Counter` ou ETW | `pidstat`, `/proc/<pid>/stat` (como `ticksDaArvore` no harness) |

Desenho do experimento do impacto no jogo (meta do PLANO: FPS médio −3%, 1% low −5%, P99 +1 ms): 3 condições (jogo sozinho; jogo + Tela sem espectador; jogo + Tela com 1 e com 5 espectadores) × **≥ 7 repetições** de 120 s num trecho de jogo determinístico (benchmark integrado ou caminho repetido), ordem **randomizada** por bloco, 30 s de aquecimento descartados, relógio da CPU fixo (`cpupower frequency-set -g performance`), temperatura estabilizada. Estatística na seção 6.

### 3.5 Tempo de inicialização

Não medido (o PLANO prevê). Procedimento: `electron --trace-startup`/`performance.now()` desde `app.on('ready')` até `ready-to-show` e até o primeiro quadro da home, 10 execuções a frio (cache de página descartado: `echo 3 > /proc/sys/vm/drop_caches`) e 10 a quente; o bundle local do desktop (`dist-desktop`) tira a rede da conta, então o alvo é dominado pelo Chromium (~0,5–1 s [L]) + o carregamento do GLB de 213 kB e o three.js lazy da abertura (`/?abertura=0` pula; usar para isolar).

---

## 4. Infra (Cloudflare)

### 4.1 Preços e limites **[D]**

| Item | Plano grátis | Pago |
|---|---|---|
| Requisições de DO | 100 000/dia | 1 M/mês incl.; US$ 0,15/M |
| Duração de DO | 13 000 GB-s/dia | 400 000 GB-s/mês incl.; US$ 12,50/M GB-s |
| Mensagens WebSocket de **entrada** | contadas **20:1** (100 mensagens = 5 requisições); saída e pings grátis | idem |
| Hibernação | DO elegível a hibernar **não paga duração**, mesmo antes de o runtime hibernar | idem |
| Limite brando por DO | ~1 000 requisições/s | idem |
| Anexo por socket (`serializeAttachment`) | máx. 16 384 bytes | idem |
| Worker (grátis) | 100 000 req/dia, 10 ms CPU/req, 50 subrequisições/invocação | ilimitado, 30 s CPU padrão |
| TURN (Realtime) | **1 000 GB/mês grátis**, depois US$ 0,05/GB; só **saída** do TURN ao cliente é cobrada | idem |

### 4.2 Modelo para N = 50 (uma sala, 50 entradas)

Contagens do código: ~30 sinais por entrada (oferta, resposta, ~15 candidatos de cada lado — `complexidade.md` §C2); 1 `watch`/`host` por socket; a presença faz ~1 275 mensagens de **saída** para 50 entradas (grátis). O Worker **não** envia ping de keepalive (o ping de 30 s existe só no servidor Node, `server.ts:129`), logo a hibernação não é quebrada por ping.

| Parcela | Conta | Resultado |
|---|---|---|
| Upgrades WebSocket | 50 espectadores + 1 host | 51 req de Worker e 51 de DO |
| Mensagens de entrada | ~32 por entrada × 50 = 1 600 → ÷ 20 | **80 req de DO** |
| Total por sala | | **~131 req de DO** (+ 51 de Worker) ⇒ ~760 salas de 50 por dia no plano grátis |
| Duração (hipótese) | cada entrada mantém o DO acordado ~15 s (troca de ICE + 245 ms de CPU medidos em D0/§C2; hiberna após ociosidade curta) × 0,128 GB | ~96 GB-s por sala ⇒ **~135 salas de 50/dia** no grátis |
| Polling de sala offline | cada tentativa de `watch` rejeitada é 1 upgrade (Worker+DO) + 1 mensagem; teto de 30 s (`POLL_MAX_MS`) = 120/h por aba | 833 abas-hora/dia consomem os 100 k de Worker; irrelevante em escala de amigos |

O que **não** está medido: a duração faturada real por entrada (a premissa de ~15 s é [H]), e o custo de CPU na plataforma (o proxy de `v8.deserialize` pode ser menor que o real; o índice por mensagem já está aplicado em `worker.ts:296–331`). Medir no Worker real: `wrangler dev` + 50 sockets, `wrangler tail`/painel de DO ("Duration", "Requests"); o `complexidade.md` §F.6 já descreve.

### 4.3 TURN

Cada espectador relayado a 1080p60 (12–16 Mbps, ADR 0010) são **~5,4–7,2 GB por hora** só de saída do TURN. Um terço do grátis (1 000 GB) acaba em ~185 espectador-horas a 12 Mbps. A fração de pares que precisam de relay varia por operadora: valores "~10–20%" circulam [L], **não há número publicado para CGNAT brasileiro** — é o item de validação humana já listado no AGENTS.md. Recomendações:
1. **Medir antes de projetar**: contar `candidate-pair` selecionado = `relay` no HUD/diagnóstico e somar `bytesReceived` por sessão (isso já é diário local; ver a regra de não haver analytics de terceiros — somar localmente, sem enviar).
2. Alarme local no host: "N espectadores via relay a X Mbps ⇒ Y GB/h", para o dono do produto decidir.
3. Alternativa de custo previsível: coturn próprio em VPS com franquia de tráfego grande (já suportado: `TURN_URLS`/`TURN_SECRET` no `wrangler.toml`), com `turns:443/tcp` como último recurso.
4. Adaptação por peer relayado violaria a R5 (parâmetros idênticos); qualquer tentativa exige ADR própria — **não** propor aqui.

---

## 5. Metodologia de medição

### 5.1 Princípios (para qualquer experimento nosso)

1. **Hipótese e métrica antes de rodar**, uma variável por vez, A/B **intercalado** (ABAB…, não todos os A e depois todos os B): a carga da máquina deriva (aqui chegou a 308).
2. **Registrar o ambiente** por execução: `loadavg`, governador de CPU, versão do Chromium/Electron, modo (headless SwiftShader vs GPU), temperatura. O harness agora pode registrar `loadavg` junto — recomendado.
3. **Repetições:** ≥ 10 por condição para efeitos de ~10%; ≥ 7 para o desempenho de jogo; descartar 1 de aquecimento + 10–15 s de acomodação do estimador.
4. **Estatística:** reportar **mediana e IQR**, não média; intervalo de confiança da mediana por **bootstrap** (10 000 reamostragens) e comparar A×B com **Mann-Whitney U** ou diferença de medianas com IC bootstrap; tamanho de efeito (Hodges-Lehmann). Distribuições de latência e de frame time são de cauda longa: **P95/P99** valem mais que a média (HdrHistogram ou ordenação simples, como o rVFC do harness).
5. **Contadores cumulativos** de `getStats()` (`totalDecodeTime`, `jitterBufferDelay`, `totalProcessingDelay`, `totalInterFrameDelay`) devem ser lidos como **delta ÷ delta de quadros** em janelas, nunca o valor absoluto [D W3C Stats: são somas acumuladas].
6. Mesma máquina para os dois relógios quando se mede latência de software; entre máquinas, só com sincronismo explícito ou câmera.

### 5.2 Campos que usar

| Pergunta | Campo | Onde | Observação |
|---|---|---|---|
| Quanto custa decodificar | `totalDecodeTime / framesDecoded` | `inbound-rtp` | [M] 1,7–3,4 ms em SW |
| Quanto o buffer segura | `jitterBufferDelay / jitterBufferEmittedCount`, `jitterBufferTargetDelay`, `jitterBufferMinimumDelay` (só rede, sem configuração externa [D]) | `inbound-rtp` | a diferença `Target − Minimum` é o quanto NÓS pagamos acima do que a rede exige |
| Receber→decodificado | `totalProcessingDelay / framesDecoded` (inclui buffer + montagem + decode [D]) | | não somar com o buffer (dupla contagem; o HUD já trata) |
| Fragmentação de quadro | `totalAssemblyTime` | | |
| Fluidez | `totalInterFrameDelay`, `totalSquaredInterFrameDelay`, `freezeCount`, `framesDropped` | | |
| Decoder em HW | `powerEfficientDecoder`, `decoderImplementation` | | **ausentes no caminho real**; usar `MediaCapabilities` |
| Custo do encoder | `totalEncodeTime / framesEncoded`, `qualityLimitationReason`, `qpSum/framesEncoded` | `outbound-rtp` | `encoderImplementation` só existe com captura de câmera/mic viva (ADR 0019) |
| Decomposição por quadro | **`googTimingFrameInfo`** (não padrão, presente [M]): `rtp_ts, capture, encode_start, encode_finish, packetization_finish, pacer_exit, network_ts, network2_ts, receive_start, receive_finish, decode_start, decode_finish, render, is_outlier, is_timer_triggered` [L: ordem conforme `TimingFrameInfo::ToString`; os campos de transmissor vêm com o formato "delta" e saíram **lixo** no "um encode", pois a mídia é reescrita pelo Encoded Transform]; o lado do receptor é confiável: nele medi **buffer 8–61 ms, decode 2 ms, decode→render 13–19 ms** | `inbound-rtp` | |
| Latência de quadro ao vivo | rVFC `expectedDisplayTime − captureTime/receiveTime`, `processingDuration`, `presentedFrames` | página | `captureTime` ausente hoje |
| Custo do navegador | CDP `Performance.getMetrics` (`TaskDuration`, `ScriptDuration`, `LayoutDuration`, `RecalcStyleDuration`) | página | [M] |
| Custo por processo | `/proc/<pid>/stat` (utime+stime, `ticksDaArvore`), `smaps_rollup` (PSS) | SO | |

`chrome://webrtc-internals` → **Create Dump** exporta o JSON bruto (todas as séries de stats); `chrome://tracing` com categorias `webrtc`, `toplevel`, `media`, `gpu`, `viz`, `cc` para ver o raster/compositor e as threads de rede (`complexidade.md` §F.1). Para o caminho do compositor com filtro, `--enable-gpu-benchmarking`/`chrome://gpu` com GPU real: o headless **não** é representativo para isso.

### 5.3 Como fechar a latência ponta a ponta sem câmera (proposta nº 1)

Duas rotas, ambas com custo moderado:

- **Fazer o `captureTime` existir.** `abs-capture-time` não é oferecido [M]. Em SDP recebido (`core/mesh/sdp-tuning.ts` já faz *munging* idempotente do SDP remoto) é possível acrescentar a linha `a=extmap:N http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time` ao `m=video`, mas o **transmissor** só estampa a extensão se o seu pipeline de captura souber o instante: na isca do "um encode" o instante é o da isca, não o do jogo [H]. Teste barato: aplicar a linha no SDP de teste e contar `comCaptura` no harness (já implementado); se vier > 0, ver se o valor faz sentido contra o relógio comum.
- **Carimbo próprio.** Como o transmissor injeta o quadro real, ele conhece o instante de captura do `VideoFrame`: guardá-lo no cabeçalho do quadro codificado via `RTCEncodedVideoFrame.setMetadata`/dado lateral por `RTCRtpScriptTransform`, e devolver em **mensagem de canal de dados** `{rtpTimestamp → captureMs}` (alguns bytes por quadro ou por segundo com `rtpTimestamp` de amostragem). O espectador converte com o offset de relógio estimado por **NTP simétrico sobre o canal de dados** (RTT/2, mediana de 20 amostras). Resultado: latência **de software** completa, ao vivo, por espectador, sem câmera. A parte física (captura do monitor, display) continua só com câmera a 240 fps (humano), que é a verdade final.

Ambos entram sob a mesma pergunta que o AGENTS.md já faz: é medida de qualidade do próprio produto, sem terceiros — compatível com a R6.

### 5.4 Harnesses a estender

| Arquivo | Extensão sugerida |
|---|---|
| `e2e/bench/estudo-decode-espectador.mjs` (este estudo) | já mede decode, jitter buffer, rVFC, CDP, overlays, varredura de piso; **falta** registrar `loadavg`, repetições internas com mediana/IC, `tc netem` opcional, PSS |
| `e2e/um-encode.e2e.mjs` | `ESPECTADORES=20/50`, somar `NetworkThread`/`PacerThread` (`complexidade.md` §F.1) |
| `e2e/qualidade.e2e.mjs` (dois Chrome reais) | acrescentar a coluna de latência (rVFC) ao lado de bpp/QP, para que nenhuma ADR de qualidade ignore o custo em ms |
| `e2e/custo-interface.e2e.mjs` | cenários com overlay (guarda do modo leve) |
| `apps/desktop/d0/*.mjs` (`main.mjs`, `injecao.mjs`) | `app.getAppMetrics()` a cada 1 s para JSON; ociosidade nativa; `PresentMon`/`MangoHud` como processo irmão |

---

## 6. O que foi MEDIDO neste estudo (método e números)

### 6.1 Método

`e2e/bench/estudo-decode-espectador.mjs` (herdado de um agente interrompido; **corrigido** porque `Browser.process()` não existe no Playwright 1.62: o processo-raiz agora é achado em `/proc` por um argumento de linha de comando inócuo `--tela-marca=`). Dois Chromium headless: transmissor com `BroadcastSession` + "um encode" e fonte em canvas (gradiente e 24 blocos em movimento, entropia alta), degrau forçado; espectador na rota de produção `/<canal>`. 12–15 s de aquecimento, 20 s de janela. CPU = utime+stime da árvore de processos; `inbound-rtp` por deltas; thread principal por CDP; rVFC por quadro. Overlays injetados após o aquecimento. Opções: `DEGRAUS`, `ESPECTADORES`, `SEGUNDOS`, `AQUECIMENTO`, `OVERLAY=none|crt|blur`, `JITTER_SWEEP=0,20,40,80`, `--json`.

### 6.2 Decode e render do espectador (1 espectador, loopback)

| Degrau | execuções válidas | núcleos (árvore do espectador) | `totalDecodeTime`/quadro | jitter buffer/quadro | fps decodificado | congel./descartes | RSS árvore |
|---|---|---|---|---|---|---|---|
| 720p60 | 6 (de 6) | 0,27–0,33 (med. ~0,30) | 1,64–1,83 ms | 25–31 ms (piso 40) | 58–60 | 0 / 0 | 577–585 MiB |
| 1080p60 | **2 válidas** de 5 | 0,51 · 0,60 | 2,58 · 3,38 ms | 7,7 · 21,3 ms | 54,7–58,1 | 0 / 0 | 603–614 MiB |

As 3 execuções de 1080p inválidas não chegaram a 1080p ao espectador: o **encoder de software do transmissor** (OpenH264 num Chromium sem GPU, com a máquina carregada) não sustenta 1080p60 (1,9 núcleo no transmissor quando sustentou) e a escada desceu para 900p/576p, como o desenho prevê. **n=2 não sustenta IC**; o que se afirma é ordem de grandeza: decode ≈ proporcional aos pixels (2,25× pixels ⇒ ~1,5–2× tempo), software. `decoderImplementation` e `powerEfficientDecoder` vieram `undefined` em todas, confirmando a ADR 0016.

Transmissor (para dimensionar o harness, não o produto): 1,0 núcleo a 720p60 e 1,9 a 1080p60 incluindo o desenho da fonte sintética; `getStats()` do host: 0,33–0,35 ms/chamada, 11–14 objetos/chamada com 1 peer (`complexidade.md` B2 estimava 1–3 ms: **a 1 peer é ~5× menos**; a N=50 continua sem medição).

### 6.3 Overlays (seção 2.3), varredura de piso (seção 1.3), rVFC e `extmap` (seção 1.3)

Já apresentados acima. Reprodução:

```bash
pnpm dev                                                   # signaling :3333 + web :5173
DEGRAUS=p720p60,p1080p60 SEGUNDOS=20 node e2e/bench/estudo-decode-espectador.mjs
OVERLAY=blur DEGRAUS=p720p60 node e2e/bench/estudo-decode-espectador.mjs
JITTER_SWEEP=0,20,40,80,0 DEGRAUS=p720p60 AQUECIMENTO=14 SEGUNDOS=6 node e2e/bench/estudo-decode-espectador.mjs
```

### 6.4 O que NÃO foi medido

GPU real (decode/compositor/energia); Windows e macOS; Firefox/Safari; N > 1 espectadores nesta bancada; rede com jitter e perda (`tc netem` exige root); potência (RAPL negado); `decoderImplementation`; tempo de inicialização do Electron; pacote final do desktop; duração faturada do DO.

---

## 7. Propostas ordenadas

Critério: (ganho esperado × confiança) ÷ custo, com a restrição de que nada viola R1–R8. "Ganho" separa o medido do estimado.

| # | Proposta | Ganho (medido / estimado) | Custo | Risco | Validação |
|---|---|---|---|---|---|
| 1 | **Fechar a medição ponta a ponta** (carimbo de captura próprio + offset de relógio por canal de dados; ou `abs-capture-time`) e levar `latência` ao `qualidade.e2e.mjs` | Habilitador: troca "subestima" por número real; hoje 0/852 quadros têm `captureTime` [M] | Médio (~150 linhas em core + adaptador, sem tocar a R5) | Baixo | harness: `comCaptura>0` e erro < 5 ms contra a mesma máquina |
| 2 | **Piso de jitter 20 ms e partida 40 ms em link calmo**, com o governador atual | **10–30 ms** [M loopback; real depende da rede] | Baixo (constantes + condição de calma) | **Médio**: congelamento/IDR em Wi-Fi | `tc netem` jitter+perda, 10 reps por piso, IC bootstrap em congelamentos/min e PLI/min |
| 3 | **Guarda automática "nada de filtro sobre o vídeo"** (teste de CSS) + `visibility:hidden` pós-fade na barra | Evita ≈ **4×** de custo de espectador [M, raster SW] | Muito baixo | Nulo | o teste falha ao reintroduzir `backdrop-filter` |
| 4 | **Ociosidade de 5 fps no caminho nativo** (se a lacuna se confirmar) | ~0,06 núcleo + ~0,1 GPU/gnome-shell + energia, em todo o tempo sem plateia [M, D0c] | Baixo (reenviar `alvo` com fps 5 com a graça de 10 s) | Baixo (IDR na troca) | `pidstat` + `nvidia-smi dmon` com 0 espectadores |
| 5 | **`MediaCapabilities` para dizer "decode em software/hardware"** no HUD e escolher o degrau inicial do espectador | Remove o `—`; evita mandar 1080p60 a quem decodifica em CPU | Baixo | Baixo (API suportada em Chromium/Safari; Firefox parcial [L]) | comparar com `chrome://media-internals` em 3 máquinas |
| 6 | **Windows: `CalculateNativeWinOcclusion` desligado** (e teste de visibilidade com jogo cobrindo a janela) | Evita parar a transmissão quando o jogo cobre o app (risco funcional, não de ms) | Muito baixo | Baixo | `rAF`/`visibilitychange` logados com jogo em borderless |
| 7 | **Windows: medir antes de construir** (WebCodecs em HW no Chromium vs caminho nativo): Task Manager "Video Encode" + PresentMon | Pode **evitar** meses de código nativo | Baixo (só medição) | — | PresentMon ≥ 7 reps × 3 condições |
| 8 | **TURN: contador local e alarme de GB/h; coturn próprio como plano B** | Previne custo surpresa: 185 espectador-horas/mês grátis a 12 Mbps [D+conta] | Baixo | Baixo | `candidate-pair` = relay no diagnóstico real |
| 9 | **`React.lazy` em `Broadcast`/`Home`/`Recover`** | −45–70 kB gzip no 1º carregamento do espectador [H, não medido] | Baixo | Baixo | `vite build` antes/depois |
| 10 | Auto-hospedar fontes (tira `fonts.googleapis.com` do 1º pintar) | −1 RTT bloqueante; privacidade | Baixo | Nulo | Lighthouse/rede |
| 11 | Sala offline: manter o WebSocket em hibernação e o DO avisar "no ar" (acaba o polling de 30 s) | 120 req/h por aba; 0 em escala de amigos | Médio (protocolo + presença) | Médio | contagem de requisições no painel |
| 12 | Investigar 5–8 ms/s de recálculo de estilo na página do espectador | ≤ 0,5% de núcleo [M] | Baixo | Nulo | trace `blink,devtools.timeline` |
| 13 | Preferir captura de janela no Linux/Mutter quando disponível | +~4 ms de defasagem média, 40→60 q/s | UX | Médio | `framesDecoded/s` |

O que **não** recomendo: trocar `<video>` por canvas/WebGL no espectador (sem ganho, perde overlay e economia de bateria); reduzir o jitter a 0 por padrão (volta o ciclo de IDR); qualquer adaptação por peer (R5).

---

## 8. Decisões e dúvidas

- **Decisão:** estendi `estudo-decode-espectador.mjs` em vez de criar outro script; as mudanças são aditivas e opcionais por variável de ambiente.
- **Dúvida 1 (alta):** a conta de duração de DO assume ~15 s acordado por entrada e 128 MB; a documentação define duração como tempo em memória e dispensa a hibernação, mas o tempo até hibernar depois de uma mensagem não foi verificado aqui.
- **Dúvida 2:** o formato de `googTimingFrameInfo` vem de memória do libwebrtc; a ordem foi confirmada só pela coerência dos 15 campos e dos intervalos receptor (35 ms buffer, 3 ms decode, 11 ms render).
- **Dúvida 3:** a lacuna da ociosidade nativa foi inferida por leitura de código (`grep`), não por medição.
- **Dúvida 4:** os números de overlay vêm de raster por software (SwiftShader) e de máquina carregada; o fator ≈4× não se transfere a GPU real — a direção sim.
- **Não verificável por mim** (AGENTS.md, tabela): latência glass-to-glass real, HW encode/decode ativos, impacto no FPS do jogo, energia, ICE em CGNAT, consumo real de TURN.

---

## Referências

**Lidas nesta sessão (primárias)**
- Cloudflare, Durable Objects pricing — https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare, Durable Objects limits — https://developers.cloudflare.com/durable-objects/platform/limits/
- Cloudflare, WebSocket Hibernation — https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cloudflare, Workers limits — https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare, Realtime TURN (preços) — https://developers.cloudflare.com/realtime/turn/faq/
- W3C, WebRTC Statistics API (`totalProcessingDelay`, `jitterBufferDelay/TargetDelay/MinimumDelay`, `totalDecodeTime`, `powerEfficientDecoder`, `totalInterFrameDelay`) — https://www.w3.org/TR/webrtc-stats/
- web.dev, `requestVideoFrameCallback` (metadados, `captureTime`/`receiveTime`, atraso de 1 vsync) — https://web.dev/articles/requestvideoframecallback-rvfc
- Electron, performance e modelo de processos — https://www.electronjs.org/docs/latest/tutorial/performance · https://www.electronjs.org/docs/latest/tutorial/process-model
- Microsoft, `GraphicsCaptureSession` (`MinUpdateInterval`, `IsBorderRequired`, `IsCursorCaptureEnabled`) — https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession
- Carrascosa & Bellalta, *Cloud-gaming: Analysis of Google Stadia traffic*, arXiv:2009.09786 (Computer Communications 188/2022); o número de jitter buffer foi extraído pela ADR 0020, o resumo lido aqui não o repete.

**Secundárias / de baixa autoridade (marcar [L])**
- Chromium issue 324276557 (implementação de `jitterBufferTarget`, M124) — https://issues.chromium.org/issues/324276557
- blink-dev, *Intent to Ship: RTCRtpReceiver playoutDelayHint* — https://groups.google.com/a/chromium.org/g/blink-dev/c/4W4orKqA3Rs
- Mozilla bug 1592988 — https://bugzilla.mozilla.org/show_bug.cgi?id=1592988
- w3c/webrtc-extensions #199 (`jitterBufferMaximumDelay`) — https://github.com/w3c/webrtc-extensions/issues/199
- "WebRTC Jitter Buffers and the playout-delay Extension" (blog; 100–125 ms em rede calma; interação com `playout-delay`) — https://lazyharu.com/en/webrtc-playout-delay/
- GameTechDev/PresentMon (README do console para as colunas) — https://github.com/GameTechDev/PresentMon
- GNOME/mutter#4214 e Discourse do GStreamer (40 q/s do Mutter), citados em `docs/desktop/D0c-nvenc-linux.md`
- LizardByte/Sunshine e variantes (host WGC) — apenas como indício de arquitetura Windows [L].

**Documentos do repositório lidos:** `AGENTS.md`; `docs/adr/0016`, `0017`, `0018`, `0019`, `0020`; `docs/engenharia/complexidade.md`; `docs/desktop/PLANO-desktop.md`, `D0-relatorio-linux.md`, `D0b-um-encode-n-envios.md`, `D0c-nvenc-linux.md`; código: `core/media/jitter-governor.ts`, `viewer-session.ts`, `broadcast-session.ts`, `core/mesh/peer-link.ts`, `adapters/browser-frame-timing.ts`, `react/use-frame-latency.ts`, `react/use-media-stats.ts`, `components/EfeitosTv.tsx`, `styles/globals.css`, `routes/Viewer.tsx`, `App.tsx`, `container.ts`, `apps/signaling/src/worker.ts`, `apps/desktop/src/main/main.ts`.
