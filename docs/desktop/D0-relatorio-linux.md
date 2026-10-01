# D0 — Prova técnica no Linux (Fedora + RTX 4050)

**Data:** 2026-10-01 · **Tarefa:** TELA-027 · **Plano:** `PLANO-desktop.md` §8–9
**Ferramentas:** `apps/desktop/d0/main.mjs` (sessão real, matriz de espectadores) e
`apps/desktop/d0/encoder.mjs` (encoder puro, WebCodecs)

## Máquina

| | |
|---|---|
| CPU | AMD Ryzen 7 7435HS — 8 núcleos / 16 threads, **sem gráfico integrado** |
| GPU | NVIDIA RTX 4050 Laptop, driver 615.71.09 |
| Sessão | Fedora 44, Wayland |
| Runtime | Electron 44.5.1 / Chromium 152.0.7977.130 |
| VA-API | `libva-nvidia-driver` 0.0.18: **só decodificação** (todos os perfis `VAEntrypointVLD`, nenhum de encode) |

## Resultado 1 — a GPU compõe, mas não codifica

Com uma janela aberta, `gpu_compositing` e `rasterization` ficam **enabled**;
`video_encode` fica **disabled_software**. O WebCodecs confirma:
`isConfigSupported({ hardwareAcceleration: 'prefer-hardware' })` → não
suportado. Todo H.264 do Chromium nesta máquina é **OpenH264, em software, na
CPU do jogo**.

Armadilha medida: consultar `getGPUFeatureStatus()` antes de existir janela
devolve tudo "disabled_software" (o processo de GPU ainda não subiu). O
harness consulta depois de abrir uma.

## Resultado 2 — custo do encoder (WebCodecs, sem rede)

| Codificação | Núcleos |
|---|---|
| 720p60 @ 8 Mbps | **0,57** |
| 1080p60 @ 12 Mbps | **1,13** |
| 1080p60 @ 20 Mbps | **1,22** |

## Resultado 3 — o Chromium codifica uma vez POR ESPECTADOR

Sessão real (`BroadcastSession`, malhas, sinalização), fonte sintética com
cara de jogo, espectadores em janelas Electron escondidas e **fora** da conta.
A rede de loopback segurou a saída em 1280×720 (a estimativa de banda trava em
~16 Mbps por link), então estes números são de 720p60.

| Espectadores | CPU do app | CPU da transmissão (sem a fonte) | Encoder |
|---|---|---|---|
| 0 (só a fonte) | 0,32 núcleo | — | — |
| 1 | 1,00 | **≈0,68** | 9,1 ms/quadro, QP 26 |
| 1, janela escondida | 1,01 | ≈0,69 | igual |
| 3 | 2,75 | **≈2,4** | 11,4 ms/quadro |
| 720p60 nominal, 1 | 0,90 | ≈0,58 | 7,9 ms/quadro, QP 32 |
| 720p60 nominal, 3 | 2,26 | **≈1,9** | 9,4 ms/quadro |

De 1 para 3 espectadores, a CPU da transmissão multiplica por ~3,3. **Não há
reaproveitamento de encoder entre `RTCPeerConnection`s** neste caminho: cada
espectador custa uma codificação inteira. A R5 parte da premissa contrária
("um encode, três envios"); aqui ela não se confirma. A regra de parâmetros
idênticos continua certa por outros motivos (adaptação coletiva), mas o custo
de CPU **escala com N**.

Memória do app: 770–850 MB, medida com o servidor de desenvolvimento (módulos
sem empacotar) — refazer com o pacote final antes de comparar com o orçamento.

## Leitura contra o orçamento (plano §1.2: ≤ 0,5 núcleo escondido)

| Situação | Custo estimado | Orçamento |
|---|---|---|
| 720p60, 1 amigo | ~0,6 núcleo | estoura de leve |
| 1080p60, 1 amigo | ~1,2 núcleo | 2,4× |
| 1080p60, 3 amigos | ~3,5 núcleos | 7× |
| 1080p60, 5 amigos | ~6 núcleos | 12× |

**No Linux com NVIDIA e sem iGPU, o caminho Chromium não cumpre o diferencial
de leveza nem em 720p com um amigo.** As duas causas são independentes e
somam: encode em software (×2 a ×3 do que seria em hardware) e um encode por
espectador (×N).

## O que NÃO foi medido aqui

- Captura de tela real (portal + PipeWire): exige clique humano no seletor.
- Impacto no jogo (MangoHud: média, 1% low, P99).
- **Windows** — Media Foundation deve codificar em hardware (NVENC); falta
  saber se também codifica uma vez por espectador. Rodar na máquina do dono.

## Caminhos para decidir (depois do D0 no Windows)

| Caminho | Resolve | Custo |
|---|---|---|
| **A. Aceitar o Chromium no Linux com limite** (720p, aviso de CPU, 1–2 amigos) | Nada do diferencial no Linux NVIDIA | Baixo |
| **B. Codificar uma vez no Chromium** (WebCodecs + Encoded Transform repassando o mesmo quadro codificado aos N envios) | O ×N, nas duas plataformas | Médio; API ainda pouco usada assim, e o Linux continua em software (~1,2 núcleo a 1080p) |
| **C. Motor de mídia nativo no Linux** (NVENC via GStreamer `nvh264enc` + `webrtcbin`, um encode para N espectadores, interoperando com o navegador pela sinalização atual) | Os dois — hardware e ×1 | Alto: é a TELA-034; captura PipeWire, sincronismo A/V, controle de banda próprios |

Recomendação provisória: medir o Windows primeiro. Se lá o encoder for hardware
e o custo por espectador baixo, o Windows segue no Chromium e o Linux NVIDIA vai
para C (com A como versão inicial publicada com limite). Se o Windows também
escalar mal com N, B entra para as duas plataformas.

## Como rodar no Windows

Na máquina Windows, com Node 22 e pnpm 10, no repositório:

```bash
pnpm install
pnpm dev                                   # deixe rodando
pnpm --filter @tela/desktop d0:encoder     # outro terminal — encoder puro (~2 min)
pnpm --filter @tela/desktop d0             # matriz com espectadores (~12 min)
```

Mande a saída dos dois e o JSON que o `d0` grava (o caminho aparece no fim).
Durante o `d0`, abra o Gerenciador de Tarefas → Desempenho → GPU e anote se
"Video Encode" sobe — é a confirmação de NVENC que o software não consegue dar.
