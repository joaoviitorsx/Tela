# Tela Desktop — análise e plano (Windows e Linux)

**Data:** 2026-10-01 · **Estado:** proposta para decisão do dono
**Tarefas:** TELA-027 a TELA-034 (plano global §20) · **ADR:** 0027 (proposta)

O desktop é **o transmissor**. Quem assiste continua no navegador, pelo mesmo
link (`tela.gg/<canal>`, ADR 0026), pedindo para entrar (ADR 0025). Nada no
protocolo, na sinalização ou nas malhas de qualidade muda por causa do app.

A regra que decide tudo abaixo: **o jogo vem antes da transmissão.** O app roda
em segundo plano enquanto alguém joga; cada milissegundo de CPU ou GPU que ele
tira do jogo é um defeito, e a transmissão degrada antes do jogo.

---

## 1. Leitura crítica da análise base

A análise que motivou este plano está certa no essencial. Três pontos dela
precisam de ajuste por causa do que este repositório já sabe, e um ponto é o
maior risco do projeto e estava subestimado.

### Adotado como está

| Proposta | Por quê |
|---|---|
| Electron, com o WebRTC do Chromium | Reaproveita o pipeline inteiro. Tauri no Linux roda sobre WebKitGTK — outro motor WebRTC, sem o encoder, o `scaleResolutionDownBy` e o `qualityLimitationReason` que as malhas usam (ADR 0015–0019) — e a validação recomeçaria do zero (plano §20.2). |
| Renderer de mídia separado do renderer de interface | Ver §2.1: é o que permite **destruir** a interface ao ir para a bandeja sem derrubar a transmissão. |
| `backgroundThrottling: false` só no renderer de mídia | É o "ajuste localizado" que o plano §20.7 pede, em vez de desligar throttling no app inteiro. |
| IPC leva estado, nunca mídia; atualização da interface a 1 Hz | Quadro não atravessa processo; telemetria agregada. |
| Processo principal quase ocioso | Bandeja, janelas, permissões e roteamento de IPC. Nada de mídia. |
| `utilityProcess` para auxiliares (PipeWire, WASAPI, sondagem de hardware) | Isola o que pode travar ou cair do resto. |
| Medir frame time do jogo (1% low, P99), não só FPS médio | Média esconde travadinha. |
| Orçamento de recursos como gate técnico | Calibrado no D0 (§7), não prometido antes. |
| Captura nativa só com problema medido | Plano §20.12 / TELA-034. |
| Game Mode | Ver §5.2 — no desenho de dois renderers ele é quase gratuito. |

### Ajustado

**"Reduzir a frequência do `getStats`."** Só a CÓPIA para a interface cai.
O laço que decide qualidade — governador de banda, evidência de colapso, sonda
(`malha-de-banda.ts`), escada de pressão de CPU — amostra a 1 s e todos os
limiares foram calibrados nessa cadência e conferidos no simulador de 1.200
cenários (ADR 0017, 0018, 0019, 0023). Mudar o intervalo sem rodar
`e2e/malhas.sim.mjs` e `e2e/qualidade.e2e.mjs` repete o erro da ADR 0019. Fica
como está.

**"Criar um resource governor."** Já existe, e é a parte mais medida do
produto: a escada de pressão desce degrau quando o encoder reporta `cpu`, a
malha de banda traduz orçamento em pixel, a captura cai para 5 fps sem
espectador, e `nitidez` troca resolução por quadro. O desktop acrescenta
**sinais** que o navegador não tem — CPU dos processos do app
(`app.getAppMetrics()`), carga da máquina, encoder em hardware ou software — e
eles entram na escada existente depois de medidos no D0, não como um segundo
governador competindo com o primeiro.

**"Prévia desligada durante a transmissão."** Sim, e há um detalhe que a
análise não cobre: `MediaStream` **não atravessa processo**. Com a mídia num
renderer e a interface em outro, a prévia na interface precisa de outro
mecanismo. Proposta: miniaturas de baixa taxa (2 quadros por segundo,
≈320×180, JPEG) geradas no renderer de mídia **só enquanto a interface estiver
visível e a prévia ligada** — custo de dezenas de KB/s, zero quando ninguém
olha. Segunda captura da mesma fonte foi descartada: no Wayland cada captura
abre o seletor do portal de novo.

### O risco que estava subestimado: encoder em hardware no Linux

A análise acerta que hardware encode importa mais que Electron × Tauri. O
problema é que, no ambiente de desenvolvimento deste projeto (Fedora +
NVIDIA), **é provável que ele não exista**:

- No Linux, o Chromium usa VA-API para encode em hardware, desligado por padrão
  e ligado por feature flags (`VaapiVideoEncoder` e afins).
- O driver VA-API da NVIDIA (`nvidia-vaapi-driver`) é declarado pelo próprio
  projeto como **só de decodificação**. Sem VA-API de encode, o H.264 do WebRTC
  cai no OpenH264, em software, na CPU — a mesma CPU do jogo.
- Notebooks híbridos têm uma iGPU Intel/AMD, cujo VA-API **codifica**. Se o
  Chromium usar a iGPU para o encode, o problema some. Isso tem de ser provado
  na máquina, não suposto.
- No Windows o caminho é Media Foundation (NVENC/Quick Sync/AMF por trás). A
  expectativa é encode em hardware, mas também é verificação do D0.

Isto é o que decide se o Linux sai com 1080p60 por padrão, com um padrão menor,
ou se a TELA-034 (encoder nativo) vira necessária. Por isso o D0 começa por
aqui, e o app ganha detecção explícita (§5.3).

Vantagem real do desktop aqui: **o app controla as flags do Chromium**
(`app.commandLine.appendSwitch`), coisa que a versão web nunca pôde.

---

## 2. Arquitetura

```text
                         TELA DESKTOP
                              │
   ┌──────────────────────────┼──────────────────────────┐
   │                          │                          │
   ▼                          ▼                          ▼
Processo principal      Renderer de INTERFACE      Renderer de MÍDIA
(Node, ~ocioso)         (React; pode MORRER)       (janela oculta; dono da sessão)
 · bandeja / janela      · passos, console,          · BroadcastSession (core/ intacto)
   compacta                pedidos, diagnóstico      · captura + WebRTC + malhas
 · setDisplayMedia-      · RemoteBroadcastSession    · backgroundThrottling: false
   RequestHandler          (proxy por MessagePort)   · nenhum DOM visível
 · permissões, atalho    · throttling normal         · miniaturas 2 fps sob demanda
 · MessageChannelMain        ▲            │                 ▲           │
   (liga UI ↔ mídia)         │ estado 1Hz │ comandos        │           │
         │                   └────────────┴─────────────────┘           │
         │                                                              ▼
         └── utilityProcess (sob demanda)                    Chromium GPU → encoder
              · PipeWire gerenciado (Linux)                   (HW quando houver)
              · WASAPI por processo (Windows, se D3 aprovar)        │
              · sondagem de hardware                                ▼
                                                        WebRTC P2P → navegadores
```

### 2.1 Por que dois renderers, e como isso respeita o plano §20.7

O §20.7 pede um único **proprietário** da sessão e cautela com renderers extras.
O desenho mantém um proprietário só — o renderer de mídia; a interface é
cliente. O renderer a mais se justifica por três necessidades concretas:

1. **Fechar = segundo plano** (pedido no mockup do app). Destruir uma
   `BrowserWindow` encerra seu renderer (§20.7). Se a sessão morasse na janela
   da interface, ir para a bandeja exigiria escondê-la — e uma janela escondida
   com `backgroundThrottling: false` continua com React, timers e
   `visibilityState = 'visible'`, de modo que nem a pausa de animações da
   TELA-026 funcionaria. Com a mídia à parte, a interface é **destruída** e o
   custo dela vai a zero.
2. **Throttling localizado.** Só a mídia precisa não ser estrangulada.
3. **Isolamento de falha.** Um travamento da interface não derruba a
   transmissão; um crash da mídia é detectado (`render-process-gone`) e
   relatado sem fingir continuidade.

Custo: um processo renderer a mais (memória, da ordem de 100 MB — a medir) e uma
camada de proxy. O D0 mede o desenho de um renderer só contra o de dois; se a
diferença de CPU com a interface escondida for desprezível **e** a política de
fechar puder ser cumprida de outro jeito, fica o mais simples.

### 2.2 Contrato de IPC

`MessageChannelMain` liga interface e mídia **diretamente**; o principal só
entrega as portas e não fica no caminho. Mensagens tipadas e validadas (schema
zod, como o protocolo de sinalização).

```text
UI → mídia (comandos)                      mídia → UI (eventos)
start {slug, preset, prioridade, áudio}     estado   snapshot da BroadcastState sem `preview`, 1 Hz
stop · pausar · retomar                     pedido   (imediato — alguém esperando)
setPreset · setPrioridade · trocarFonte     miniatura JPEG, 2 Hz, só se pedida
aceitarPedido · recusarPedido               diagnóstico sob pedido
desconectarTodos · volume
prévia on/off · diagnóstico
```

`BroadcastState` já é quase toda serializável; o único campo que não é,
`preview: MediaStream`, vira `previa: 'miniaturas' | 'desligada'`. A interface
usa os hooks de hoje (`useBroadcast`) sobre um `RemoteBroadcastSession` que
implementa a mesma superfície — rotas e componentes da web são reaproveitados.

### 2.3 Segurança (plano §20.8)

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
`webSecurity` preservado nos dois renderers. Interface e mídia carregadas de um
protocolo próprio (`app://tela/…`), não de `file://` e nunca de URL remota.
Preload expõe só operações nomeadas; navegação e janelas novas negadas;
links externos validados. Sem secrets no pacote.

### 2.4 URLs, Origin e identidade (plano §20.6)

- **Link compartilhado** = URL pública HTTPS configurada no build
  (`https://tela.transmissao.workers.dev/<canal>` hoje), nunca `app://`.
  Hoje `shareUrlFor` deriva de `window.location.origin`; o container desktop
  injeta a origem pública.
- **Sinalização** = WSS configurado. O renderer manda `Origin: app://tela`;
  o Worker passa a aceitá-lo via `ALLOWED_ORIGINS` (TELA-019). Origin não é
  autenticação — continua valendo token do dono e aprovação.
- **Identidade:** o app tem armazenamento próprio. Quem já transmite pela web
  tem o canal preso ao `ownerToken` do navegador; sem importar, o app recebe
  `SLUG_TAKEN` no próprio nome. Primeiro uso oferece **"já usa o Tela no
  navegador? cole o código de recuperação"** (o fluxo `/recuperar` existe).

### 2.5 Onde o código mora

Sem reorganizar o monorepo (plano §20.3):

```text
apps/desktop/                 NOVO — só o que é Electron
  src/main/                   ciclo de vida, bandeja, janelas, handler de captura,
                              permissões, atalho, autostart, MessageChannelMain
  src/preload/                ponte mínima e tipada (uma por renderer)
  src/utility/                PipeWire gerenciado, WASAPI (D3), sondagem
  electron-builder.yml        empacotamento

apps/web/src/
  core/                       INTACTO (R1/R3) — BroadcastSession roda no renderer de mídia
  desktop/                    NOVO
    media-entry.ts            monta a BroadcastSession com os adapters web + SessionHost
    ui-entry.tsx              monta as rotas com RemoteBroadcastSession
    container.desktop.ts      composição desktop (único que importa adapters, como hoje)
    session-host.ts           expõe a sessão por MessagePort
    remote-session.ts         proxy do lado da interface
```

`getDisplayMedia` funciona no Electron quando o principal registra
`setDisplayMediaRequestHandler`, então o adapter de captura web serve; o que
muda é quem escolhe a fonte (o principal, a partir da escolha do usuário na
nossa interface).

---

## 3. Captura e áudio por plataforma

| | Windows | Linux (Fedora, Wayland/Xorg) |
|---|---|---|
| **Escolha da fonte** | `desktopCapturer.getSources` + lista com miniaturas na NOSSA interface (tela ou janela do jogo) | Portal ScreenCast (seletor do sistema). Uma fonte por vez; sem lista de janelas (§20.5) |
| **Vídeo** | `getDisplayMedia` com o handler do principal | Idem, via PipeWire |
| **Som do sistema** | `audio: 'loopback'` no handler — tudo que toca, inclusive a call | Monitor de saída via PipeWire (o modo `monitor-device` de hoje) |
| **Só o som do jogo** | WASAPI por processo (build ≥ 20348) + **ponte PCM → MediaStreamTrack** — nativo, D3, condicional | PipeWire: ligar só o nó do jogo a um sink virtual do Tela e capturar o monitor dele — **sem ponte**, o Chromium captura como dispositivo. Evolui a TELA-010 para gerenciado |
| **Sem áudio** | Escolha explícita | Escolha explícita |

Proposta de ponte no Windows, a provar no D3: `utilityProcess` com addon
nativo (WASAPI process loopback) → `MessagePort` → `AudioWorklet` com buffer
circular no renderer de mídia → `MediaStreamAudioDestinationNode` → trilha
publicada. Exige timestamps, compensação de deriva de relógio e sincronismo
A/V medidos. Até passar, o app anuncia **som do sistema** no Windows, nunca
"só o jogo" (plano §20.4).

---

## 4. Ciclo de vida e segundo plano (plano §20.7)

| Evento | Comportamento |
|---|---|
| Minimizar | Interface com throttling normal; mídia segue |
| Fechar a janela ao vivo | Primeira vez: pergunta "continuar em segundo plano?" (lembra a escolha). Sim → interface **destruída**, controle pela bandeja e pela janela compacta |
| Sem bandeja (GNOME do Fedora sem extensão AppIndicator) | A janela compacta do mockup é o controle sempre disponível; nunca transmissão escondida sem acesso |
| Encerrar | `stop()` da sessão (já libera trilhas, peers, timers e avisa a sala), depois sair |
| Suspender o sistema | `powerMonitor`: encerra com motivo explícito; não promete continuidade |
| Crash da mídia | `render-process-gone` → interface mostra "transmissão caiu", diagnóstico preservado |
| Atalho global (`Ctrl+Shift+T` no mockup) | `globalShortcut` no Windows/Xorg; no Wayland depende do portal GlobalShortcuts — verificar no D4, sem prometer |
| Iniciar com o sistema | Windows: `setLoginItemSettings`; Linux: `.desktop` em `~/.config/autostart` (com caminho estável do AppImage). Abre minimizado, **sem capturar nada** |
| Atualização | Nunca instala nem baixa durante a transmissão |

---

## 5. Desempenho

### 5.1 Durante a transmissão, quem faz o quê

| Processo | Trabalho |
|---|---|
| Principal | Nada periódico além de bandeja e IPC |
| Interface | Destruída (bandeja) ou viva com 1 Hz de estado; sem animação infinita (já garantido pela TELA-026, agora vale com a interface realmente fechada) |
| Mídia | Captura, encode, `getStats` 1 s (malhas — não mexer), envio |
| Utility | Só quando houver áudio gerenciado; dorme no resto |

### 5.2 Game Mode

Com a interface podendo ser destruída, o Game Mode é o estado natural, não um
modo especial: **ao vivo + interface fechada**. Se a interface estiver aberta:
prévia vira miniatura sob demanda (padrão desligada ao vivo), nenhuma
animação contínua, atualizações e downloads adiados, log reduzido.

### 5.3 Encoder: detectar, não deduzir

- `app.getGPUInfo('complete')` deve trazer os perfis de encode acelerado que o
  Chromium enxerga — **verificar no D0** que o campo existe e é confiável.
- `msPorQuadro` (já medido): acima de 16,7 ms em 1080p60 é quase sempre
  software.
- O diagnóstico do app mostra **encoder: hardware / software / desconhecido** —
  "desconhecido" quando não dá para afirmar.
- Se for software, o padrão de resolução cai (ex.: 720p60) e o app diz por quê.

### 5.4 Orçamento inicial (gate do D0, calibrado lá)

| Métrica, transmitindo 1080p60 com 1 espectador | Alvo inicial |
|---|---|
| CPU do app (todos os processos), máquina de referência | ≤ 5% |
| CPU da interface fechada | 0 (processo não existe) |
| Memória total do app | ≤ 700 MB |
| FPS médio do jogo | perda ≤ 5% |
| 1% low do jogo | perda ≤ 8% |
| P99 do frame time | aumento ≤ 1,5 ms |
| Encode | hardware onde a máquina tem |

Números iniciais, para serem confirmados ou corrigidos pela medição — não são
promessa externa. Memória pesa menos que CPU e frame time para quem joga.

### 5.5 `tela --benchmark`

Modo interno: transmite uma cena de referência a um espectador local (outro
renderer ou navegador) por N segundos, para 0/1/3/5 espectadores, e grava
JSON com: CPU e memória por processo (`app.getAppMetrics()`), GPU quando o
sistema expõe, encoder (hardware/software), resolução/fps/bitrate/bpp/QP
saindo, quadros descartados e `qualityLimitationReason`. O frame time do jogo
vem de fora, medido por humano: **MangoHud** no Linux, **PresentMon /
CapFrameX** no Windows, com e sem o Tela, mesma cena.

---

## 6. Empacotamento e distribuição (plano §20.9)

- **electron-builder**: Windows NSIS (x64); Linux AppImage (o que o mockup
  anuncia) e, se o dono quiser, RPM para Fedora.
- **Atualização: electron-updater**, que cobre NSIS e AppImage (o
  `autoUpdater` embutido do Electron não cobre Linux). Canal estável/beta.
  Nunca durante a transmissão.
- **Assinatura no Windows**: sem certificado, o SmartScreen avisa em toda
  instalação. É custo e decisão do dono.
- **AppImage no Fedora**: pode exigir FUSE 2 (`fuse-libs`), que nem toda
  instalação tem — verificar; o RPM não tem esse problema.
- CI: build por plataforma, artefatos com hash, nenhum secret no pacote.
- Os botões do modal **BAIXAR APP** do site só ligam depois da homologação.

---

## 7. Fases

Um marco por vez (AGENTS.md); cada um termina em relatório e decisão.

| Fase | Tarefa | Entrega | Sai quando |
|---|---|---|---|
| **D0 — Prova técnica** | TELA-027 | App Electron mínimo, sem acabamento: renderer de mídia oculto rodando a `BroadcastSession` atual, captura pelo handler, transmissão para um navegador; `tela --benchmark`; detecção de encoder | Matriz §8 medida nos ambientes disponíveis; **decisão registrada na ADR 0027: seguir, seguir com limitação (ex.: Linux NVIDIA a 720p) ou abrir TELA-034** |
| **D1 — Shell e sessão remota** | TELA-028 | Processos, preloads, `app://`, `MessageChannelMain`, `SessionHost` + `RemoteBroadcastSession`, container desktop, URLs configuradas, importação do código de recuperação, Origin aceito no Worker, moldura da §11 (trilho + painel NO AR) em volta das telas do site | Interface reaproveitada transmitindo pelo proxy; testes de IPC (schema, remetente, tamanho) |
| **D2 — Captura** | TELA-029 | Seletor próprio no Windows; portal no Linux; troca de fonte; fim da fonte; miniaturas | Matriz de limitações por ambiente |
| **D3 — Áudio** | TELA-030 | Windows: som do sistema. Linux: roteamento PipeWire gerenciado (evolução da TELA-010) com "só o jogo". Windows "só o jogo": spike da ponte WASAPI | Jogo + call simultâneos: o espectador ouve o jogo e não a call, no modo anunciado; L/R e sincronismo medidos |
| **D4 — Segundo plano** | TELA-031 | Bandeja (com contador de pedidos), janela compacta com ACEITAR/RECUSAR, política de fechar, autostart, atalho, suspensão, crash | Política da §4 testada nos dois sistemas |
| **D5 — Distribuição** | TELA-032 | NSIS, AppImage (± RPM), atualizador, assinatura, pipeline | Instalar/atualizar/desinstalar em máquina limpa |
| **D6 — Homologação** | TELA-033 | Relatório por plataforma e modo | Decisão: liberar, liberar com limitação publicada, ou bloquear |
| **D7 — Motor nativo** | TELA-034 | Só se o D0/D6 provar limitação (ex.: Linux NVIDIA em software) e o dono aprovar | — |

**O D0 vem antes de qualquer acabamento.** Se o encoder no Linux NVIDIA for
software e a CPU estourar o orçamento, isso muda o produto, e é melhor saber
na primeira semana.

---

## 8. Matriz da prova técnica (D0)

| Ambiente | Por quê |
|---|---|
| Windows 11, GPU NVIDIA | Caso principal de jogo; Media Foundation/NVENC |
| Fedora Wayland, notebook híbrido usando a dGPU NVIDIA | Máquina do dono; pior caso provável de encode |
| Fedora Wayland, encode pela iGPU (VA-API) | A saída provável para o caso acima |
| Fedora Xorg | Portal e atalhos diferentes |

Em cada um: 0/1/3/5 espectadores, 1080p60 e 720p60, jogo real, com e sem o
Tela: CPU/memória por processo, encoder, bpp/QP, quadros descartados, e frame
time do jogo (média, 1% low, P99).

---

## 9. Riscos

| Risco | Efeito | Mitigação / detecção |
|---|---|---|
| Linux + NVIDIA sem encode H.264 em hardware | CPU do jogo paga o encode | D0 mede primeiro; iGPU VA-API; padrão menor; TELA-034 |
| Windows sem certificado | SmartScreen em toda instalação | Decisão de orçamento do dono |
| GNOME sem bandeja | "Fechar = segundo plano" sem controle | Janela compacta como controle garantido |
| Atalho global no Wayland | Atalho não dispara | Portal GlobalShortcuts se disponível; senão, só bandeja/janela |
| Portal pede a tela a cada transmissão | Um clique a mais | Aceito; restauração de sessão do portal só se o Electron expuser |
| "Só o jogo" no Windows exige ponte nativa | Dessincronia, deriva, crash | Spike isolado no D3; até lá, "som do sistema" declarado |
| Canal preso ao token do navegador | `SLUG_TAKEN` no primeiro uso | Importar código de recuperação no primeiro uso |
| AppImage sem FUSE 2 | Não abre | RPM como alternativa |
| Interface e mídia divergindo de versão | IPC quebra | Versão no contrato; os dois saem do mesmo build |

---

## 10. O que só humano verifica (AGENTS.md)

Frame time e FPS do jogo (MangoHud, PresentMon); encoder em hardware de fato
(`chrome://gpu`/`getGPUInfo` mais carga do encoder no gerenciador da GPU);
áudio "só o jogo" com call aberta; atalhos e bandeja no ambiente gráfico real;
instalação em máquina limpa; SmartScreen; ICE em redes reais.

---

## 11. Interface: organização do Discord, cara do Tela

Quem vai usar o app já passa o dia no Discord. Vale emprestar **a
organização** dele — onde as coisas ficam e como o "Go Live" flui — e nada da
aparência: nem cores, nem marca, nem componentes copiados. A pele continua a do
site (ADR 0022): âmbar sobre preto, numerais de placar, painéis OSD, LED, chiado
estático, abertura e TV 3D.

### 11.1 O que vem do Discord

| Padrão do Discord | No Tela Desktop |
|---|---|
| Trilho de ícones à esquerda | Trilho fino com 4 destinos: **Transmitir**, **Sala** (pedidos e quem assiste), **Diagnóstico**, **Ajustes** — botões com o relevo de tecla do site |
| Painel de status no canto inferior ("Voz conectada" + desligar) | Painel **NO AR** fixo no rodapé do trilho: LED, tempo, `3/5`, rota (`Direta · 18 ms`), ENCERRAR. Visível em qualquer tela |
| Modal "Transmitir" com abas *Aplicativos / Telas* e miniaturas | Seletor de fonte com abas **JOGO E JANELAS / TELAS** e miniaturas (Windows). No Linux, botão que abre o portal do sistema |
| Escolha de qualidade em fichas (resolução, fps) | As abas de resolução e 30/60 fps que o site já tem |
| Configurações com categorias à esquerda | **Ajustes**: *Aplicativo* (iniciar com o sistema, fechar = segundo plano), *Captura e áudio*, *Atalhos*, *Avançado* (diagnóstico, flags de encoder) — exatamente as linhas do mockup |
| Toast de chamada recebida | Pedido para assistir como aviso com ACEITAR/RECUSAR, na janela que estiver aberta |
| Mini-janela / sobreposição | A **janela compacta** do mockup: link, tempo, espectadores, pedidos, ENCERRAR |

### 11.2 O que o Discord não resolve e o desktop precisa resolver

**Pedido com a interface fechada.** Com a interface destruída (§2.1), a fila
de pedidos não tem onde aparecer. Os avisos são três, todos baratos:

1. **Bipe**, que já existe e toca do renderer de mídia, sem interface.
2. **Contador na bandeja**, ex.: `Tela · 1 pedido`.
3. **Janela compacta com ACEITAR/RECUSAR**, que abre sozinha por cima ao chegar
   um pedido, se o dono permitir nos Ajustes.

Notificação do sistema fica opcional e desligada: no meio de uma partida ela
rouba foco em alguns jogos em tela cheia.

### 11.3 Esboço

```text
┌───┬──────────────────────────────────────────────────────────────┐
│ ▣ │  MENU ▸ TRANSMITIR                                            │
│TV │  ┌ JOGO E JANELAS ┬ TELAS ┐                                    │
│   │  │ [mini] [mini] [mini]   │   RESOLUÇÃO  1080p60 900p60 720p60 │
│ ◉ │  │ [mini] [mini]          │   QUADROS    60 FPS · 30 FPS       │
│SALA│ └────────────────────────┘   SOM        Sistema ▸ Só o jogo   │
│   │                                                                │
│ ▤ │                              [ ■ IR AO AR E GERAR LINK ]       │
│DIAG│                                                               │
│ ⚙ │                                                                │
├───┴──────────────────────────────────────────────────────────────┤
│ ● NO AR 00:42:10 · tela.gg/joao · 3/5 · Direta 18 ms  [ENCERRAR] │
└──────────────────────────────────────────────────────────────────┘
```

As telas do site são reaproveitadas como estão (passos, console, fila de
pedidos, fim da transmissão); o que muda é a moldura de navegação em volta.

### 11.4 Custo visual

Tudo que for decoração contínua — chiado animado, TV 3D, brilho pulsando —
fica fora da tela de transmissão ao vivo. A TV 3D e a abertura continuam na
entrada do app, que roda antes do jogo. Durante a transmissão, a interface é
estática ou não existe.

## 12. Decisões do dono antes do D0

1. **Dois renderers** (mídia separada) — recomendado; ou um só, decidido pela
   medição do D0.
2. **Formato Linux:** AppImage (como no mockup), RPM, ou os dois.
3. **Certificado de código para Windows:** comprar agora, depois, ou lançar
   beta com aviso do SmartScreen.
4. **"Só o som do jogo" no Windows:** aceitar lançar com "som do sistema" e
   tratar a ponte WASAPI como evolução, ou bloquear o lançamento Windows até ela.
5. **Máquinas de teste:** confirmar a do D0 (Fedora + RTX 4050 — tem iGPU
   ativa?) e se há uma máquina Windows com jogo para medir.
6. **Janela compacta abrindo sozinha ao chegar pedido:** ligada ou desligada
   por padrão.
