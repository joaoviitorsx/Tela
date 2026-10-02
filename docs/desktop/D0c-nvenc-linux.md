# D0c — NVENC no Linux, fora do Chromium

Fedora 44 · GNOME 50.5 (Wayland) · Ryzen 7 7435HS · RTX 4050 Laptop (sem iGPU),
driver 615.71 · GStreamer 1.28.7 · Electron 44.5.1 (Chrome 152). Medido em
2026-10-01.

## O problema que sobrou do D0/D0b

No Linux com NVIDIA o Chromium codifica H.264 em **software** (a VA-API da
NVIDIA só decodifica): ~1,2 núcleo em 1080p60. O D0b tirou o custo POR
espectador ("um encode, N envios"), mas o encode único continuou em software, e
copiar o quadro para fora do Chromium (`VideoFrame.copyTo`) custa 5–20 ms em
1080p. A meta da fase: **1080p60 com ≤ 0,5 núcleo**.

## O que foi feito

`apps/desktop/nativo/linux/tela-captura.c` — um processo que captura e codifica
sozinho, sem passar pelo Chromium:

```text
 portal ScreenCast ─► PipeWire (DMA-BUF) ─► appsink ══╗   CAPTURA (sempre viva)
                                                      ║
 appsrc ─► glupload ─► glcolorscale ─► glcolorconvert ║   CODIFICAÇÃO (recicla
        ─► NV12 ─► nvh264enc ─► H.264 Annex B ─► stdout   na troca de tamanho)
```

- Saída no protocolo `[u32 tamanho][u8 tipo][corpo]`: quadro H.264, evento JSON
  (`pronto`, `stats`, `erro`) e "captura" (relógio da isca, abaixo). Ordens por
  stdin: `alvo L A fps bps`, `chave`, `atraso n`, `parar`.
- No renderer, `CodificadorExterno` (`apps/web/src/adapters/codificador-externo.ts`)
  implementa a mesma interface do `CodificadorWebCodecs`; o transporte "um
  encode" recebe o codificador por fábrica. Malhas, sinalização e espectador
  **não mudam**.
- `--fonte=mutter:<conector>` usa a API privada do GNOME, sem diálogo: só para
  teste automatizado. O produto usa o portal, que pergunta ao usuário e devolve
  um `restore_token` para não perguntar de novo.

### Decisão: GStreamer, não NVENC SDK direto

O plano (§13.1) previa um addon com `dlopen` da `libnvidia-encode` e
interop EGL/CUDA próprio. Com o GStreamer do sistema (`nvh264enc` carrega a
mesma biblioteca do driver) a prova saiu medida em um dia, e o NVENC fica atrás
de uma porta trocável. Custo: dependência em tempo de execução de
`gstreamer1-plugins-bad` (nvcodec), `pipewire-gstreamer` e dos plugins GL. O
binário checa e responde `SEM_NVENC`/`SEM_COMPONENTE`; o app cai no WebCodecs.
RPM/DEB declaram as dependências; no AppImage é detecção em tempo de execução.
Se a cobertura de distros incomodar, o SDK direto entra no lugar do pipeline sem
mudar o protocolo.

## Medidas

**Custo** (processo `tela-captura`, por `/proc`; gnome-shell à parte):

| Caminho | Núcleo (processo) | gnome-shell a mais |
|---|---|---|
| PipeWire memória → NVENC | 0,064–0,081 | +0,10 a +0,15 |
| **PipeWire DMA-BUF → GL → NVENC** | **0,054–0,070** | **~0** |
| OpenH264 no Chromium (D0) | ~1,2 | — |

NVENC: **2,5 ms** por quadro 1080p (entrada→saída do encoder).

**Controle de taxa** (`nvh264enc` CBR, p4, ultra-low-latency, VBV de 4
quadros nesta medição; desde 2026-10-02 o código usa 2, ver estudo/1-codec.md), conteúdo de entropia alta: 12 Mbps pedidos → 12,3 saem; 4 → 4,1;
maior quadro ≈ 1,1× o orçamento de um quadro. Troca de `bitrate` ao vivo **não**
gera IDR; troca de `vbv-buffer-size` gera (medido) — por isso o VBV só é
definido no início e na troca de tamanho, que já recomeça em IDR.

**Fim a fim** (`TELA_D0_MODO=nativo pnpm --filter @tela/desktop exec electron d0/injecao.mjs`):
BroadcastSession real + 1 e 3 espectadores na rota `/<canal>` de produção.

| Espectadores | Degrau | Resolução recebida | fps decodificado | bpp | Congel./perdas/PLI | Host (renderer) | Nativo |
|---|---|---|---|---|---|---|---|
| 1 | p1080p60 | 1920×1080 | 37 | 0,19 | 0/0/0 | 0,14 | 0,07 |
| 3 | p1080p60 | 1920×1080 (os 3) | 36 | 0,18–0,21 | 0/0/0 | 0,24 | 0,07 |

O renderer do host inclui desenhar a fonte sintética (o "jogo" do harness);
no D0b, o mesmo cenário com WebCodecs em software custava 1,62 núcleo.

## Defeitos achados medindo

1. **GL não renegocia tamanho com o fluxo andando** — falha até sem NVENC.
   Troca de degrau recicla a codificação em READY: ~0,1 s sem quadro, e IDR.
2. **Reciclar o pipeline inteiro matava a captura**: o Mutter não volta a
   entregar quadros depois de READY. Daí os dois pipelines — a captura nunca
   para; só a codificação recicla.
3. **Deadlock de contrapressão**: o processo descartava quadros por atraso dos
   senders, nenhum quadro chegava, a isca não andava e a fila nunca drenava —
   ~1 q/s, só IDRs de PLI. Quadro descartado agora manda a mensagem "captura",
   que move a isca como o `aoCapturar` do WebCodecs.
4. **Degrau preso em 600p**: o NVENC reparte o bitrate pelo fps configurado
   (60) e o Mutter entrega ~40; saía 2/3 do pedido, a estimativa colava em
   `1,5 × enviado` e a malha nunca subia (ADR 0018). O processo corrige o
   bitrate pelo fps medido (fator 1–2×).

## Limite conhecido: o Mutter entrega ~40 q/s de monitor

Medido com conteúdo a 60 fps, de várias formas (memória ou DMA-BUF, com ou
sem encoder, `max-framerate=60`): ~40 q/s em monitor de 165 Hz. É do
compositor, não do pipeline — relatos iguais no
[GNOME/mutter#4214](https://gitlab.gnome.org/GNOME/mutter/-/issues/4214) e no
[Discourse do GStreamer](https://discourse.gstreamer.org/t/pipewiresrc-not-using-full-framerate/5570)
(captura de JANELA não teria o limite). O Chromium captura pelo mesmo
caminho, então vale para a web também.

## Não verificado (humano)

| O quê | Como |
|---|---|
| Diálogo do portal e `restore_token` | `tela-captura --fonte=portal`: escolher a tela, conferir que a 2ª execução com `--restaurar=<token>` não pergunta |
| fps com jogo real em tela cheia, monitor e janela | Jogo a 60+ fps; `pnpm --filter @tela/desktop d0:nativo` (monitor) e o portal escolhendo a janela do jogo |
| Impacto no FPS do jogo | MangoHud com e sem transmissão |
| KDE/Plasma (outro compositor) | Mesma medida num Plasma |
| Ubuntu/Debian com os pacotes do sistema | `nativo/linux/build.sh` e o d0:nativo |

## Reproduzir

```bash
# cabeçalhos (Fedora): gcc gstreamer1-devel gstreamer1-plugins-base-devel glib2-devel
pnpm --filter @tela/desktop nativo:build
pnpm --filter @tela/desktop d0:nativo                     # helper sozinho: IDR, trocas, CPU, ffprobe
pnpm dev &                                                # noutro terminal
TELA_D0_MODO=nativo pnpm --filter @tela/desktop exec electron d0/injecao.mjs
```

Os dois abrem janela e capturam o monitor inteiro (só local).
