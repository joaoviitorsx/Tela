# D2 — Captura no Tela Desktop

**Data:** 2026-10-02 · **Tarefa:** TELA-029 · **Plano:** `PLANO-desktop.md` §3.3, §8, §11 · **Antes:** D1 (`app://`, ponte), D0c (`tela-captura`)

O D1 entregava a primeira tela inteira, sem escolha. O D2 entrega os três
caminhos de captura do app, atrás do MESMO `ScreenCapture` que a
`BroadcastSession` usa na web — o `core/` não mudou uma linha (R1/R3).

```text
                     BroadcastSession.start() → screen.request()
                                       │
                 captura-desktop.ts (apps/web/src/desktop)
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
 1. NATIVO (Linux, NVENC)     2. SELETOR PRÓPRIO (Windows, X11)   3. PORTAL (Wayland)
 main sobe tela-captura        UI com abas e miniaturas            getDisplayMedia de
 → portal → PipeWire → NVENC   → escolherFonte(id) → main          sempre; o diálogo
 → MessagePort → codificador   → getDisplayMedia consome a         é do sistema
 externo; trilha-fantasma        escolha UMA vez
```

Quem decide o caminho é `capacidades()` do main, uma vez ao abrir o app:
`nvenc` (a sonda do binário) e `seletorProprio` (plataforma e sessão). Se o
nativo falhar ao subir (portal ausente, plugin faltando), a captura cai no 2
ou no 3 **em silêncio** e não tenta de novo nessa execução; o console da
transmissão mostra `WebCodecs·…` em vez de `nativo·NVENC`.

## 1. Seletor próprio (Windows e Linux X11)

Organização do modal "Transmitir" do Discord com a pele do site (§11): abas
**JOGO E JANELAS / TELAS**, grade de miniaturas, `<dialog>` nativo (foco
preso, `Esc`, página inerte), abas por ←/→, cada miniatura um botão.

| Peça | Onde | O que faz |
|---|---|---|
| Listagem | `main/fontes-de-captura.ts` + `main.ts` | `desktopCapturer.getSources` com miniatura 320×180 em JPEG q70 (~15 KB cada) e ícone da janela; telas primeiro, em português; fora a janela do próprio Tela e janelas sem título; teto de 60 |
| Loja | `desktop/seletor-de-fontes.ts` | `abrir()` devolve uma promessa; lista a cada 2 s **só enquanto aberto**; fechado não guarda fonte (as miniaturas são o que pesa) |
| Interface | `components/SeletorDeFontes.tsx` (burro) + `desktop/use-seletor-de-fontes.ts` (`useSyncExternalStore`) + `desktop/SeletorDeFontesDesktop.tsx` | Montado na moldura; abre quando o adapter de captura pede |
| Escolha | IPC `tela:escolher-fonte` | O main só aceita um id da ÚLTIMA listagem (`escolhaValida`); guarda para o próximo `getDisplayMedia`, que a consome uma vez; `null` cancela |
| Handler | `setDisplayMediaRequestHandler` | Sem escolha pendente responde vazio → `NotAllowedError` → `DENIED` (cancelar é escolha, R4). Windows + TELA + áudio pedido → `audio: 'loopback'`; janela no Windows é muda, e o `surface` entregue à sessão diz a verdade (`monitor`/`window`) |

Decisões: o seletor abre na aba **TELAS** (no Windows é a única com som do
sistema; a aba de janelas mostra o aviso antes de escolher). Em Electron o
`displaySurface` da trilha não vem, então a superfície vem da escolha.

## 2. Caminho nativo (Linux com NVENC)

### 2.1 Sonda ao abrir

`tela-captura --sondar` (novo modo no C): confere os elementos do GStreamer
e põe o `nvh264enc` em READY — é NULL→READY que abre a sessão no driver
(CUDA + `NvEncOpenEncodeSessionEx`); sem GPU utilizável, driver trocado ou
sessões esgotadas, falha aqui. Escreve `{"evento":"sonda","nvenc":true,
"gstreamer":"…"}` no protocolo e sai 0; senão `erro` (`SEM_NVENC` /
`SEM_COMPONENTE`) e 3. Não captura, não abre diálogo. O main roda com prazo
de 8 s (`sondarNvenc`) e guarda em `capacidades().nvenc` + `nvencDetalhe`.

### 2.2 Ciclo de vida (`main/captura-nativa.ts`)

```text
iniciando ──pronto──► capturando ──parar()──► encerrando ──exit──► encerrado
    │ exit                 │ exit
    ▼                      ▼
err(CANCELADO|SEM_*|PORTAL|PIPELINE|MORREU|INDISPONIVEL)   encerrou(fim) → renderer
```

- `spawn` e relógio injetados: a máquina de estados é testada com um
  processo de mentira (fragmentação do protocolo, sinais, trocas, morte).
- `iniciar` sobe `tela-captura --fonte=portal --alvo=L,A,fps,bps
  [--restaurar=<token>]`. O token do portal vem do evento `pronto` e vai
  para `userData/captura-portal.json`; na próxima transmissão o portal não
  pergunta (persist_mode 2, D0c).
- **Trocar de fonte** é um `iniciar` com outra sessão no ar: a nova sobe
  primeiro e só no `pronto` dela a antiga é parada em silêncio. Cancelar o
  portal da nova mantém a antiga — cancelar a troca não derruba a transmissão.
- `parar`: `parar\n` no stdin, fecha o cano, SIGTERM em 1,5 s, SIGKILL em 3 s;
  os timers são cancelados se o processo sair sozinho. Quem pediu para parar
  não recebe `encerrou`.
- O processo morrer capturando → `tela:captura-nativa-encerrou` com o motivo
  do último `erro` (`FONTE_ENCERRADA`, `PIPELINE`, `PORTAL`) ou `MORREU`.
- Ordens do renderer passam por `ordemValida` (regex do protocolo): a porta
  vem de uma página web, e o stdin do processo não é lugar de texto livre.
- Renderer caído (`render-process-gone`) e `before-quit` → `pararTudo()`.

### 2.3 Porta e codificador (renderer)

- `main` cria um `MessageChannelMain` por sessão: quadros e eventos vão por
  `port1` (o `ArrayBuffer` transferido, sem cópia); ordens voltam. `port2` vai
  ao preload por `webContents.postMessage`, que o repassa ao mundo da página
  com `window.postMessage({tipo: MARCA_DA_PORTA, id}, '*', [porta])` — o
  jeito documentado pelo Electron; `contextBridge` não transfere portas.
- `desktop/porta-nativa.ts`: o codificador externo nasce com o transporte,
  antes de haver processo; o proxy guarda ordens sem porta e eventos sem
  ouvinte (o `pronto` chega antes de `iniciar`), e é religado na troca de
  fonte (`ligar(id, porta)` fecha a anterior; `desligar(id)` só se for a atual).
- `desktop/codificador-comutavel.ts`: decide em `iniciar(track)` — a trilha
  é a fantasma → `CodificadorExterno`; é uma captura real → `CodificadorWebCodecs`.
  Trocar de fonte para o outro caminho para um e inicia o outro no mesmo alvo
  (o próximo quadro é IDR de qualquer jeito). Genérico sobre a forma do
  codificador porque `src/desktop/` não importa `adapters/` (lint); o
  container passa as fábricas de verdade.
- `desktop/trilha-fantasma.ts`: canvas 320×180 parado com um cartaz,
  `captureStream(0)` e um `requestFrame`. É o que a sessão publica, põe na
  prévia e observa. **Parar a fantasma para o processo** (inclusive quando a
  sessão desiste antes de publicar); **o processo morrer encerra a fantasma**
  com `stop()` + `dispatchEvent(new Event('ended'))` — o mesmo caminho pelo qual
  uma trilha real leva a sessão a `stop('CAPTURE_ENDED')`.
- O tamanho real da fonte vem do `pronto` (`CodificadorExterno.fonte()`), não
  da fantasma. A superfície é `desconhecido`: o portal não diz monitor/janela,
  e no Linux o som não vem da captura — não muda o que a pessoa recebe.

### 2.4 Empacotamento

- `electron-builder.yml`: no Linux, `nativo/linux/build/tela-captura` vai em
  `resources/nativo/tela-captura` (`extraResources`); `main.ts` resolve
  `process.resourcesPath/nativo` empacotado e `nativo/linux/build/` no repositório.
- deb: `recommends` gstreamer1.0-plugins-bad (nvcodec), gstreamer1.0-pipewire,
  gstreamer1.0-gl, gstreamer1.0-plugins-base. rpm: `Recommends:` via
  `--rpm-tag` do fpm — gstreamer1-plugins-bad-free, pipewire-gstreamer,
  gstreamer1-plugins-base (conferido no Fedora 44: `libgstnvcodec.so` está no
  bad-free, `libgstopengl.so` no plugins-base). Recomendado, não exigido: quem
  não tem NVIDIA instala e transmite pelo WebCodecs.
- AppImage: nenhuma dependência declarável; o `--sondar` decide ao abrir.
- CI (`desktop.yml`, job Ubuntu): instala `libgstreamer1.0-dev
  libgstreamer-plugins-base1.0-dev libglib2.0-dev` e roda `build.sh` antes do
  electron-builder.

## 3. IPC acrescentado (`apps/web/src/desktop/ponte.ts` é o contrato)

| Canal | Sentido | Payload |
|---|---|---|
| `tela:capacidades` | invoke | → `{ nvenc, nvencDetalhe, seletorProprio }` |
| `tela:listar-fontes` | invoke | → `FonteDeCaptura[]` (id, nome, tipo, miniatura, icone) |
| `tela:escolher-fonte` | invoke | `string \| null` → `boolean` |
| `tela:captura-nativa-iniciar` | invoke | `{ width, height, fps }` → `{ ok, id, fonte, memoria } \| { ok: false, erro }` |
| `tela:captura-nativa-parar` | send | `number` |
| `tela:captura-nativa-porta` | main → renderer | `{ id }` + `ports[0]` |
| `tela:captura-nativa-encerrou` | main → renderer | `{ id, motivo, codigo }` |

Todo `invoke` confere a origem do frame (`origemPermitida`), e todo payload
passa por função pura testada (`escolhaValida`, `pedidoDeCapturaValido`,
`ordemValida`).

## 4. Verificado (máquina do dono, Fedora 44, 2026-10-02)

- `pnpm --filter @tela/desktop run typecheck|lint|test|build`: 73 testes, 5 arquivos.
- `pnpm --filter @tela/web run typecheck|lint|test|build|build:desktop`
  (`VITE_SIGNAL_URL=ws://x/signal VITE_PUBLIC_ORIGIN=https://x`): 684 testes, 63 arquivos.
- `pnpm depcruise`: sem violações (305 módulos).
- `nativo/linux/build.sh` com os cabeçalhos extraídos
  (`PKG_CONFIG_PATH=<devroot>/usr/lib64/pkgconfig PKG_CONFIG_FLAGS=--define-prefix`),
  e `tela-captura --sondar`:
  `{"evento":"sonda","nvenc":true,"gstreamer":"GStreamer 1.28.7"}`, saída 0.

Nada acima abriu janela, portal ou captura.

## 5. Não verificado — precisa de humano

| O quê | Como |
|---|---|
| **Windows, seletor com jogo real** | `pnpm --filter @tela/desktop dev:app`, TRANSMITIR: as duas abas, miniaturas do jogo (tela cheia e janela), escolher uma janela → transmissão **muda** e `surface: window` no diagnóstico; escolher TELA → som do sistema (`loopback`); cancelar o seletor → "você cancelou", não erro técnico |
| **Wayland, portal e token** | Fedora/GNOME: 1ª transmissão abre o diálogo do portal; `pronto` com `restaurar` grava `~/.config/Tela/captura-portal.json`; 2ª transmissão **não pergunta**; revogar em Configurações → Privacidade e conferir que volta a perguntar |
| **Wayland, nativo de ponta a ponta** | Diagnóstico com `nativo·NVENC` e `memoria: dmabuf`; 1 e 3 espectadores web em 1080p; CPU do `tela-captura` ≤ 0,1 núcleo (`top`); TROCAR DE TELA abre o portal de novo e a anterior continua até a nova entregar; cancelar a troca mantém a antiga |
| **Fim de fonte** | Transmitir uma janela pelo nativo e fechá-la: a transmissão encerra com `CAPTURE_ENDED` (não trava, não fica preta); mesma coisa com `kill -9` no `tela-captura` |
| **Fallback transparente** | Renomear `libgstnvcodec.so` (ou `GST_PLUGIN_FEATURE_RANK`) e abrir o app: `capacidades().nvenc=false`, transmissão pelo WebCodecs, diagnóstico `WebCodecs·…` |
| **X11** | Sessão Xorg no GNOME: seletor próprio aparece (não o portal); miniaturas de janelas; com NVENC o `tela-captura` tenta o portal ScreenCast — se o backend não existir em X11, cai no seletor + WebCodecs e `motivoDoFallback()` diz `PORTAL` |
| **Pacotes** | `dist:linux`: `resources/nativo/tela-captura` executável no AppImage/deb/rpm; `dpkg -I`/`rpm -qp --recommends` mostram as recomendações; instalar numa máquina sem NVIDIA e transmitir |
| **Memória do seletor** | Abrir o seletor com ~30 janelas por 1 min, fechar: memória do renderer volta (as miniaturas são descartadas ao fechar) |

## 6. Decisões fora dos documentos

- Seletor abre em TELAS, não em JOGO E JANELAS (som do sistema no Windows).
- Troca de fonte no nativo: nova sessão antes de parar a antiga (sem buraco,
  e cancelar não derruba). Custo: dois `tela-captura` por alguns segundos.
- `--alvo` inicial a 0,1 bit por pixel (piso da ADR 0010) só até a primeira
  ordem `alvo` do codificador.
- Com `capacidades.nvenc` o app tenta o nativo mesmo em X11 (o portal
  ScreenCast existe em Xorg no GNOME); se falhar, fallback e não tenta de novo
  na execução.
- `surface: 'desconhecido'` no caminho nativo; o helper não foi mudado para
  reportar `source_type` do portal (fora do escopo de "só `--sondar`").
- `OCUPADO` (dois `iniciar` ao mesmo tempo) vira `FAILED`, sem abandonar o nativo.
