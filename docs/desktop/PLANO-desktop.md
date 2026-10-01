# Tela Desktop — análise e plano (Windows e Linux)

**Data:** 2026-10-01 · **Estado:** D0 no Linux medido (`D0-relatorio-linux.md`); falta o Windows
**Tarefas:** TELA-027 a TELA-034 (plano global §20) · **ADR:** 0027

O desktop transmite **e** assiste. O link continua um só (`tela.gg/<canal>`,
ADR 0026; entrada direta, ADR 0028): quem tem o app instalado abre no app,
quem não tem assiste no navegador (§14). Nada no protocolo, na sinalização ou
nas malhas de qualidade muda por causa do app.

A regra que decide tudo abaixo: **o jogo vem antes da transmissão.** O app roda
em segundo plano enquanto alguém joga; cada milissegundo de CPU ou GPU que ele
tira do jogo é um defeito, e a transmissão degrada antes do jogo.

---

## 1. O diferencial: qualidade e leveza, as duas medidas

O dono definiu as duas frentes que tornam o Tela diferente no mercado:
**imagem melhor** e **app mais leve**. Elas puxam em direções opostas — mais
qualidade custa mais encode, mais leveza pede menos trabalho — e o que as
reconcilia é tirar do caminho todo custo que não vira imagem.

### 1.1 Qualidade — o que o desktop permite que a web não permite

| Alavanca | O que faz | Onde |
|---|---|---|
| **Encoder em hardware garantido quando existe** | O app liga as flags do Chromium que a web não pode (ex.: encode VA-API no Linux) e **detecta** se o encode é hardware ou software, em vez de supor | §6.3, D0 |
| **Padrão de resolução pelo encoder real** | Hardware → 1080p60 por padrão. Software → o padrão cai e o app diz por quê, em vez de entregar 1080p borrado | §6.3 |
| **Captura no tamanho escolhido** | `crop-and-scale` já existe; a troca ao vivo já mexe na captura | feito |
| **Escada honesta de bits por pixel** | Malha de banda, colapso e sonda (ADR 0015–0019, 0023) seguem iguais — é o que mais diferencia a imagem hoje | feito |
| **Som só do jogo** | A call não vaza para os amigos; menos ruído no Opus de 128 kbps | §4 |
| **A interface não disputa GPU com o encoder** | Durante o jogo, nada desenha | §6.2 |

### 1.2 Leveza — o orçamento

| Métrica, transmitindo 1080p60 com 1 espectador | Alvo inicial (calibrado no D0) |
|---|---|
| CPU do app (todos os processos), janela escondida | ≤ 3% |
| CPU do app com a janela aberta | ≤ 5% |
| Memória total | ≤ 600 MB |
| FPS médio do jogo | perda ≤ 3% |
| 1% low do jogo | perda ≤ 5% |
| P99 do frame time | aumento ≤ 1 ms |
| Encode | hardware onde a máquina tem |

Mais apertado que a primeira versão do plano: se é diferencial, o número tem de
ser melhor do que "aceitável". Continua sendo calibração — o D0 mede e o número
vira gate de release (D6), não promessa antes da medição.

### 1.3 O que NÃO se troca por leveza

O laço de qualidade amostra `getStats` a cada 1 s, e todos os limiares das
malhas foram calibrados nessa cadência e conferidos no simulador de 1.200
cenários (ADR 0017–0019, 0023). Espaçar esse laço para "economizar" repete o
erro da ADR 0019. O que fica mais barato é tudo **em volta** dele: a interface,
a prévia, os processos auxiliares.

---

## 2. Leitura crítica da análise base

| Proposta da análise | Decisão |
|---|---|
| Electron com o WebRTC do Chromium | **Adotado.** Tauri no Linux usa WebKitGTK, outro motor WebRTC, e as malhas foram calibradas no Chromium |
| Renderer de mídia separado da interface | **Não — decisão do dono: uma janela só.** A leveza vem do modo escondido explícito (§3.2) e do modo compacto na mesma janela |
| `backgroundThrottling: false` | **Adotado**, na única janela, compensado pelo modo escondido |
| IPC leva estado, nunca mídia | **Adotado**; com uma janela, o IPC fica pequeno (§3.3) |
| Main quase ocioso; `utilityProcess` para auxiliares | **Adotado**; o utility só existe quando o som "só do jogo" no Windows está ligado |
| Frame time do jogo (1% low, P99) | **Adotado** como métrica principal |
| Reduzir frequência do `getStats` | **Só a cópia para a tela.** O laço de qualidade fica em 1 s (§1.3) |
| Criar um resource governor | **Já existe** (escada de CPU, malha de banda, captura a 5 fps sem espectador, nitidez). O desktop acrescenta sinais (CPU por processo, encoder) depois de medidos |
| Hardware encode importa mais que o framework | **Concordo, e é o maior risco** (§6.3): no Linux com NVIDIA o encode provavelmente cai em software |
| Captura nativa só com problema medido | **Adotado** (TELA-034) |

---

## 3. Arquitetura (janela única)

```text
                          TELA DESKTOP
                               │
        ┌──────────────────────┼──────────────────────────┐
        ▼                      ▼                          ▼
 Processo principal      Renderer único             utilityProcess
 (Node, ~ocioso)         (a janela do Tela)         (só com "som do jogo"
  · bandeja                · interface React          no Windows)
  · janela: normal,        · BroadcastSession          · addon nativo WASAPI
    compacta, escondida      (core/ intacto)             (process loopback)
  · setDisplayMedia-       · captura + WebRTC          · PCM → MessagePort ──┐
    RequestHandler           + malhas                                      │
  · lista de fontes        · backgroundThrottling:false                     │
  · permissões, atalho,    · MODO ESCONDIDO explícito ◄── aviso do main    │
    autostart              · AudioWorklet ◄─────────────────────────────────┘
  · avisa visibilidade            │
                                  ▼
                       Chromium GPU → encoder (HW quando houver)
                                  │
                                  ▼
                       WebRTC P2P → navegadores dos amigos
```

### 3.1 Por que uma janela funciona

A sessão vive no renderer da janela; **fechar não destrói a janela, esconde**.
Um processo a menos (memória menor, nada de proxy, a prévia é o `MediaStream`
local de hoje). O que a separação dava de graça — custo zero da interface
fora da tela — vem do modo escondido.

Riscos assumidos e mitigação:

- **Travamento da interface derruba a transmissão.** A `BroadcastSession` já
  vive fora da árvore React; uma barreira de erro (error boundary) em volta das
  rotas impede que um erro de render desmonte o dono da sessão. Crash do
  renderer inteiro (`render-process-gone`) é detectado pelo main, que mostra
  "transmissão caiu" e preserva o diagnóstico — nunca finge continuidade.
- **Throttling desligado na janela toda.** Ver §3.2.

### 3.2 Modo escondido (o Game Mode de verdade)

Com `backgroundThrottling: false`, o Chromium não marca a página como oculta, e
a pausa automática de animações da TELA-026 (`data-aba="oculta"`) deixaria de
disparar. Então o **main avisa a página**, explicitamente, toda vez que a janela
some (minimizada, fechada para a bandeja, coberta pelo jogo em tela cheia
quando detectável):

| Ao esconder | Ao mostrar |
|---|---|
| `data-aba="oculta"` → toda animação CSS pausada | Retoma |
| `<video>` da prévia sem `srcObject` → nada decodifica nem compõe | Volta a prévia |
| TV 3D e abertura descartadas (`dispose`, GPU devolvida) | Remontam se a tela inicial abrir |
| Relógios de interface parados (tempo no ar, cronômetros visuais) | Recalculam pelo relógio da sessão |
| Atualização de estado para React a 1 Hz (já é) | Igual |
| Downloads de atualização, logs verbosos: adiados | Igual |

O que **nunca** para escondido: captura, encode, envio, `getStats` de 1 s e as
malhas. Isso é a transmissão.

### 3.3 IPC (pequeno, porque é uma janela só)

Main ↔ renderer, por preload tipado e validado (schema), sem acesso genérico a
Node:

```text
renderer → main                         main → renderer
listarFontes()  (Windows: janelas+telas) visibilidade {visivel}
escolherFonte(id)                        bandeja: encerrar · copiar link · mostrar
capacidades()   (encoder, GPU, sistema)  atalho global disparado
ajustes: autostart, fechar=bandeja,      crash/recuperação
         atalho
estadoAoVivo {no ar, tempo, n/5}  ──► tooltip e ícone da bandeja (1 Hz, só mudança)
somDoJogo.start(pid) / stop()  ──► utilityProcess; PCM volta por MessagePort
```

### 3.4 Segurança (plano §20.8)

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
`webSecurity` preservado. Interface carregada de protocolo próprio
(`app://tela/…`), nunca de URL remota. Preload só com operações nomeadas;
navegação e janelas novas negadas; links externos validados. Sem secrets no
pacote.

### 3.5 URLs, Origin e identidade (plano §20.6)

- **Link compartilhado** = URL pública HTTPS configurada no build, nunca
  `app://`. Hoje `shareUrlFor` deriva de `window.location.origin`; o container
  desktop injeta a origem pública.
- **Sinalização** = WSS configurado; o Worker aceita `Origin: app://tela` via
  `ALLOWED_ORIGINS` (TELA-019).
- **Identidade:** quem já transmite pela web tem o canal preso ao `ownerToken`
  do navegador; sem importar, o app recebe `SLUG_TAKEN` no próprio nome. Primeiro
  uso oferece **"já usa o Tela no navegador? cole o código de recuperação"**.

### 3.6 Onde o código mora

Sem reorganizar o monorepo (plano §20.3):

```text
apps/desktop/                 NOVO — só o que é Electron
  src/main/                   janela (normal/compacta/escondida), bandeja, handler de
                              captura, lista de fontes, permissões, atalho, autostart
  src/preload/                ponte mínima e tipada
  src/utility/                som do jogo no Windows (D3)
  native/wasapi-loopback/     addon N-API em C++ (D3)
  electron-builder.yml        empacotamento

apps/web/src/
  core/                       INTACTO (R1/R3)
  desktop/                    NOVO
    entry.tsx                 monta as rotas e a sessão no renderer
    container.desktop.ts      composição desktop (único que importa adapters)
    adapters/                 fonte escolhida pelo main, som do jogo (AudioWorklet),
                              capacidades, visibilidade
```

---

## 4. Som: o usuário escolhe

Três opções na interface, nas duas plataformas, com o modo **real** sempre
visível — nunca "áudio ativo" só porque existe uma trilha:

| Opção | Windows | Linux |
|---|---|---|
| **Som do sistema** | `audio: 'loopback'` do Electron — tudo que toca, inclusive a call. Sem componente nativo | Monitor da saída padrão via PipeWire (o modo `monitor-device` de hoje) |
| **Só o jogo** | **Componente nativo** (abaixo) | PipeWire: o app liga só o nó do jogo a um sink virtual do Tela e captura o monitor dele; o jogo continua tocando no fone. Evolui a TELA-010 para gerenciado. **Sem ponte nativa**: o Chromium captura como dispositivo |
| **Sem som** | Escolha explícita | Escolha explícita |

### 4.1 O componente nativo do Windows

O Windows tem uma API própria para capturar o áudio de **um processo** (e dos
filhos dele): *WASAPI process loopback*. O Electron não a expõe — o `loopback`
dele é o sistema inteiro. Então:

```text
utilityProcess
  └─ addon nativo (C++, N-API)
       ActivateAudioInterfaceAsync( PROCESS_LOOPBACK, PID do jogo, incluir filhos )
       → IAudioClient → PCM float32, 48 kHz, estéreo, blocos de 10 ms
  └─ MessagePort (transferível, sem cópia por JSON)
renderer
  └─ AudioWorklet: buffer circular (~60 ms), compensa deriva de relógio
       → MediaStreamAudioDestinationNode → trilha → grafo de ganho → publicada
```

- **Por que `utilityProcess`:** se o addon cair, cai sozinho; o renderer vê o
  fim da fonte e mostra "som do jogo parou", sem derrubar o vídeo.
- **Requisito de sistema:** a API exige uma build mínima do Windows (a amostra
  oficial pede 20348). O app consulta a versão; abaixo dela, "só o jogo" aparece
  como indisponível e explica por quê — nunca troca em silêncio por som do
  sistema.
- **Escolha do jogo:** pelo processo dono da janela escolhida para captura
  (`desktopCapturer` dá a janela; o main resolve o PID).
- **Aceite (D3):** jogo + call simultâneos → o espectador ouve o jogo e **não**
  a call; L/R preservados; sincronismo A/V medido; 1 h sem deriva audível; troca
  de fone e fim do jogo com estado explícito.
- **Custo:** compilação nativa no CI do Windows (node-gyp/prebuild), mais um
  artefato a manter. É o único código nativo do plano.

---

## 5. Ciclo de vida e segundo plano (plano §20.7)

| Evento | Comportamento |
|---|---|
| Minimizar | Modo escondido (§3.2); transmissão segue |
| Fechar a janela ao vivo | Primeira vez pergunta "continuar em segundo plano?" e lembra. Sim → janela **escondida** (não destruída), controle pela bandeja |
| Modo compacto | A mesma janela, redimensionada (mockup "janela compacta"): link, tempo, `n/5`, ENCERRAR. Sempre no topo opcional |
| Sem bandeja (GNOME do Fedora sem AppIndicator) | Fechar vai para o **modo compacto**, nunca some sem controle |
| Encerrar | `stop()` da sessão (já libera trilhas, peers, timers e avisa a sala), depois sair |
| Suspender o sistema | `powerMonitor`: encerra com motivo explícito |
| Crash do renderer | Main detecta, mostra "transmissão caiu", preserva diagnóstico |
| Atalho global (`Ctrl+Shift+T`) | `globalShortcut` no Windows/Xorg; no Wayland depende do portal GlobalShortcuts — verificar no D4 |
| Iniciar com o sistema | Windows: `setLoginItemSettings`; Linux: `.desktop` em `~/.config/autostart`. Abre na bandeja, **sem capturar nada** |
| Atualização | Nunca baixa nem instala durante a transmissão |

---

## 6. Desempenho

### 6.1 Quem faz o quê, ao vivo e escondido

| Processo | Trabalho |
|---|---|
| Principal | Bandeja (tooltip só quando muda) e IPC raro |
| Renderer | Captura, encode, envio, `getStats` 1 s, malhas. Interface pausada |
| GPU (Chromium) | Encode; composição da janela parada |
| Utility | Só com "som do jogo" no Windows |

### 6.2 Custo visual

TV 3D, abertura, chiado animado e brilho pulsando ficam fora da tela de
transmissão. A interface ao vivo é estática; escondida, não desenha. A medição
da TELA-026 (`e2e/custo-interface.e2e.mjs`) ganha uma linha para o app desktop
escondido.

### 6.3 Encoder: detectar, não deduzir — e o maior risco

- No Linux, o Chromium codifica em hardware via VA-API, desligado por padrão e
  ligado por feature flags. O driver VA-API da NVIDIA (`nvidia-vaapi-driver`) é
  declarado pelo próprio projeto como **só de decodificação**: com NVIDIA, o
  H.264 do WebRTC tende a cair no OpenH264, em software, na CPU do jogo.
  Notebook híbrido pode codificar pela iGPU Intel/AMD — **a provar no D0**.
- No Windows, o caminho é Media Foundation (NVENC/Quick Sync/AMF). Expectativa
  de hardware, também verificada no D0.
- Detecção no app: `app.getGPUInfo('complete')` (perfis de encode acelerado —
  confirmar no D0 que o campo existe e é confiável) mais `msPorQuadro` (já
  medido; acima de 16,7 ms em 1080p60 é quase sempre software).
- Diagnóstico mostra **encoder: hardware / software / desconhecido**.
- Software → padrão cai (ex.: 720p60) com explicação. Se nem assim cumprir o
  orçamento, abre a TELA-034 (encoder nativo) para esse caso.

### 6.4 `tela --benchmark`

Transmite uma cena de referência para espectadores locais (0/1/3/5) por N
segundos e grava JSON: CPU e memória por processo (`app.getAppMetrics()`), GPU
quando o sistema expõe, encoder, resolução/fps/bitrate/bpp/QP, quadros
descartados, `qualityLimitationReason`. Frame time do jogo, medido por humano:
**MangoHud** no Linux, **PresentMon/CapFrameX** no Windows, com e sem o Tela,
mesma cena.

---

## 7. Distribuição (decidida)

| Plataforma | Formato | Atualização |
|---|---|---|
| **Windows x64** | Instalador NSIS, **sem assinatura** por enquanto | `electron-updater` (funciona sem assinatura) |
| **Linux x86_64** | **AppImage** como principal — roda em qualquer distro sem instalar | `electron-updater` (suporta AppImage) |
| | **RPM** (Fedora) e **DEB** (Ubuntu/Debian) como opções | Sem auto-update; o app avisa que há versão nova e aponta o pacote |

- **Sem assinatura no Windows:** o SmartScreen mostra "O Windows protegeu o
  computador" em toda instalação. A página de download explica o caminho
  ("Mais informações → Executar assim mesmo") e publica o SHA-256 do
  instalador. Assinar fica para quando houver usuários pagando a conta.
- **AppImage no Fedora:** pode exigir FUSE 2 (`fuse-libs`); a página oferece o
  RPM como alternativa e o comando para instalar a dependência.
- **Flatpak** fica para depois: o sandbox complica o roteamento de áudio do
  PipeWire, que é exatamente o "só o jogo" do Linux.
- Nunca baixar nem instalar atualização ao vivo. CI gera os artefatos por
  plataforma, com hash; nenhum secret no pacote.

---

## 8. Fases

Um marco por vez (AGENTS.md); cada um termina em relatório e decisão.

| Fase | Tarefa | Entrega | Sai quando |
|---|---|---|---|
| **D0b — Um encode, N envios** | TELA-027 | Protótipo isca + Encoded Transform + VideoEncoder único (feito, `D0b-um-encode-n-envios.md`) | Custo por espectador ~0,2 núcleo, medido |
| **D0c — NVENC no Linux** | TELA-034 (antecipada) | Addon: captura PipeWire + NVENC + saída H.264 para o ponto de injeção | 1080p60 com ≤ 0,5 núcleo no Fedora do dono |
| **D0 — Prova técnica** | TELA-027 | App Electron mínimo: a `BroadcastSession` atual na janela, captura pelo handler, transmissão para um navegador; modo escondido; `tela --benchmark`; detecção de encoder | Matriz §9 medida; **decisão na ADR 0027**: seguir, seguir com limitação (ex.: Linux NVIDIA a 720p) ou abrir TELA-034 |
| **D1 — Shell** | TELA-028 | `app://`, preload, container desktop, URLs configuradas, importação do código de recuperação, Origin no Worker, moldura da §11 | Telas do site rodando no app; testes de IPC |
| **D2 — Captura** | TELA-029 | Seletor próprio com miniaturas no Windows; portal no Linux; troca e fim de fonte | Matriz de limitações por ambiente |
| **D3 — Som** | TELA-030 | Sistema / só o jogo / sem som nas duas plataformas; addon WASAPI no Windows; PipeWire gerenciado no Linux | Aceite da §4.1 com jogo + call |
| **D4 — Segundo plano** | TELA-031 | Bandeja, modo compacto, política de fechar, autostart, atalho, suspensão, crash | Política da §5 nos dois sistemas |
| **D5 — Distribuição** | TELA-032 | NSIS, AppImage, RPM, DEB, atualizador, página de download | Instalar/atualizar/desinstalar em máquina limpa |
| **D6 — Homologação** | TELA-033 | Relatório por plataforma e modo, contra o orçamento da §1.2 | Liberar, liberar com limitação publicada, ou bloquear |
| **D7 — Motor nativo** | TELA-034 | Só se D0/D6 provarem limitação e o dono aprovar | — |
| **D8 — Assistir no app** | — | Esquema `tela://`, tentativa única na página do canal com volta ao navegador, modo espectador no app | Link abre no app com ele instalado e no navegador sem ele, nas duas plataformas |

**O D0 vem antes de qualquer acabamento.** Se o encoder no Linux NVIDIA for
software e estourar o orçamento, isso muda o produto, e é melhor saber cedo.

---

## 9. Matriz da prova técnica (D0)

| Ambiente | Por quê |
|---|---|
| **Windows do dono, com jogos** | Caso principal de jogo; Media Foundation/NVENC |
| **Fedora Wayland do dono (RTX 4050)**, encode pela NVIDIA | Pior caso provável |
| **Mesmo notebook, encode pela iGPU (VA-API)**, se houver iGPU ativa | A saída provável para o caso acima |
| Fedora Xorg | Portal e atalhos diferentes |

Em cada um: 0/1/3/5 espectadores, 1080p60 e 720p60, jogo real, com e sem o
Tela, janela aberta e escondida: CPU/memória por processo, encoder, bpp/QP,
quadros descartados, frame time do jogo (média, 1% low, P99).

---

## 10. Riscos

| Risco | Efeito | Mitigação / detecção |
|---|---|---|
| Linux + NVIDIA sem encode H.264 em hardware | CPU do jogo paga o encode | D0 primeiro; iGPU VA-API; padrão menor; TELA-034 |
| Janela única: crash do renderer derruba a transmissão | Transmissão cai junto com a interface | Sessão fora da árvore React + error boundary; main detecta crash e informa |
| Modo escondido falha em algum caso (ex.: jogo em tela cheia por cima sem minimizar) | Interface desenhando à toa | Sinal explícito do main; medição no D0 com a janela coberta |
| Sem assinatura no Windows | Aviso do SmartScreen em toda instalação | Decisão do dono; instrução e hash na página |
| GNOME sem bandeja | Fechar some sem controle | Fechar vai para o modo compacto |
| Atalho global no Wayland | Não dispara | Portal GlobalShortcuts se houver; senão bandeja/compacto |
| Addon WASAPI: deriva de relógio, dessincronia, crash | Som ruim ou cortado | Utility isolado; buffer com compensação; aceite D3; som do sistema sempre disponível como escolha |
| AppImage sem FUSE 2 | Não abre | RPM/DEB como alternativa |
| Canal preso ao token do navegador | `SLUG_TAKEN` no primeiro uso | Importar código de recuperação |
| Sala aberta (ADR 0028) | Quem tiver o link assiste, sem aviso ao dono | Decisão do dono; aprovação religável por flag |

---

## 11. Interface: organização do Discord, cara do Tela

Quem vai usar o app já passa o dia no Discord. Vale emprestar **a organização**
dele — onde as coisas ficam e como o "Go Live" flui — e nada da aparência: nem
cores, nem marca, nem componentes copiados. A pele continua a do site (ADR
0022): âmbar sobre preto, numerais de placar, painéis OSD, LED, chiado
estático, abertura e TV 3D.

| Padrão do Discord | No Tela Desktop |
|---|---|
| Trilho de ícones à esquerda | Trilho fino: **Transmitir**, **Sala** (quem assiste), **Diagnóstico**, **Ajustes** — com o relevo de tecla do site |
| Painel de status no rodapé ("Voz conectada" + desligar) | Painel **NO AR** fixo: LED, tempo, `3/5`, rota (`Direta · 18 ms`), encoder (`HW`), ENCERRAR |
| Modal "Transmitir" com abas *Aplicativos / Telas* | Seletor com abas **JOGO E JANELAS / TELAS** e miniaturas (Windows); no Linux, botão que abre o portal |
| Qualidade em fichas | As abas de resolução e 30/60 fps do site |
| Configurações por categoria | **Ajustes**: *Aplicativo* (iniciar com o sistema, fechar = segundo plano), *Captura e som*, *Atalhos*, *Avançado* (diagnóstico, encoder) |
| Mini-janela | **Modo compacto** da mesma janela |

```text
┌───┬──────────────────────────────────────────────────────────────┐
│ ▣ │  MENU ▸ TRANSMITIR                                            │
│TV │  ┌ JOGO E JANELAS ┬ TELAS ┐                                    │
│   │  │ [mini] [mini] [mini]   │   RESOLUÇÃO  1080p60 900p60 720p60 │
│ ◉ │  │ [mini] [mini]          │   QUADROS    60 FPS · 30 FPS       │
│SALA│ └────────────────────────┘   SOM   Sistema · Só o jogo · Sem  │
│   │                                                                │
│ ▤ │                              [ ■ IR AO AR E GERAR LINK ]       │
│DIAG│                                                               │
│ ⚙ │                                                                │
├───┴──────────────────────────────────────────────────────────────┤
│ ● NO AR 00:42:10 · tela.gg/joao · 3/5 · Direta 18 ms · HW [ENCERRAR]│
└──────────────────────────────────────────────────────────────────┘
```

As telas do site são reaproveitadas (passos, console, fim da transmissão); muda
a moldura de navegação em volta.

---

## 12. O que só humano verifica (AGENTS.md)

Frame time e FPS do jogo (MangoHud, PresentMon); encoder em hardware de fato
(gerenciador da GPU mostrando carga de encode); "só o jogo" com call aberta;
bandeja, atalhos e modo escondido no ambiente gráfico real; instalação em
máquina limpa e o aviso do SmartScreen; ICE em redes reais.

---

## 13. Resultado do D0 no Linux (resumo)

Detalhes em `D0-relatorio-linux.md`. Nesta máquina (RTX 4050, sem iGPU):

- Encode H.264 **em software** (VA-API da NVIDIA só decodifica): 0,57 núcleo
  em 720p60 e 1,13–1,22 em 1080p60.
- **Uma codificação por espectador**: CPU da transmissão ×3,3 de 1 para 3
  amigos. A premissa de encoder compartilhado da R5 não se confirmou aqui.
- Contra o orçamento (≤ 0,5 núcleo): 1080p60 com 3 amigos fica em ~3,5 núcleos.
- Caminhos A/B/C no relatório; decisão depois do D0 no Windows.

### 13.1 Arquitetura de mídia que sai do D0

O D0b (`D0b-um-encode-n-envios.md`) provou dentro do Chromium o "um encode,
N envios": o custo por espectador a mais caiu de ~1,2 para ~0,2 núcleo, com o
espectador web de produção recebendo 1080p sem mudança. Isso reorganiza o
caminho de mídia do desktop em duas peças:

```text
 CODIFICADOR (um só, trocável)                     ENVIO (um por espectador)
 ─────────────────────────────                     ────────────────────────
 Windows: VideoEncoder prefer-hardware (MF/NVENC)   RTCPeerConnection de hoje,
 Linux NVIDIA: addon NVENC com captura PipeWire     isca 160×90 + Encoded Transform
 Linux sem HW: VideoEncoder (OpenH264)               (Encoded Source quando o
          │                                          Chromium publicar)
          └──── H.264 Annex B por MessagePort ────►  mesma malha de banda: o degrau
                                                     e o bitrate passam a mirar o
                                                     codificador único
```

**Linux NVIDIA:** o `copyTo` de um quadro 1080p custa de 5 a 20 ms, então o
addon não recebe quadros do Chromium — ele captura pelo PipeWire (portal
ScreenCast, DMA-BUF quando a NVIDIA aceitar, memória compartilhada quando não),
codifica no NVENC (a `libnvidia-encode` vem com o driver, carregada por
`dlopen`) e entrega H.264 ao mesmo ponto de injeção. O WebRTC, a sinalização e
o espectador não mudam.

**Pendências antes de produto** (D0b §"O que falta"): IDRs por reconfiguração
da isca, reconexão ocasional, malhas mirando o codificador.

**R5:** a premissa "um encode, três envios" não vale no Chromium sem esta
arquitetura (D0). A regra de parâmetros idênticos continua necessária; o
texto da R5 deve ser corrigido por ADR junto com a adoção do codificador único.

## 14. Um link, app ou navegador (pedido do dono, 2026-10-01)

Quem clica em `tela.gg/<canal>`: com o app instalado, abre no app; sem o app,
assiste no navegador como hoje. Não existe API para o site saber se o app está
instalado, então o fluxo é o dos apps de chamada:

1. O instalador registra o esquema `tela://` (Windows:
   `app.setAsDefaultProtocolClient`; Linux: `x-scheme-handler/tela` no
   `.desktop` do RPM/DEB e na integração do AppImage).
2. A página do canal, ao abrir, tenta `tela://assistir/<canal>` **uma vez**.
   Com o app, o navegador pergunta "Abrir Tela?" (o usuário pode marcar
   "sempre"), o app abre no canal e a página mostra "aberto no app".
3. Sem o app, nada acontece; depois de ~1,5 s com a página ainda em foco, ela
   segue no navegador e grava `tela.semApp` para não tentar de novo nesse
   navegador. Um botão **ABRIR NO APP** fica sempre disponível.
4. No app, o deep link é validado (formato do slug, nada além de assistir) e
   **nunca** inicia captura nem transmissão.
5. O app ganha o modo espectador: a rota `Viewer` da web, a `ViewerSession`
   de hoje, numa janela própria.

Entra como fase **D8 — Assistir no app e abrir pelo link**, depois do D4.

## 15. Decisões do dono (2026-10-01)

| # | Pergunta | Decisão |
|---|---|---|
| 1 | Renderer de mídia separado ou janela única | **Janela única** — leveza pelo modo escondido (§3.2) |
| 2 | Formato no Linux | **O melhor para portar:** AppImage principal + RPM e DEB (§7) |
| 3 | Assinatura no Windows | **Sem assinatura** por enquanto, com o aviso do SmartScreen |
| 4 | Som no Windows | **O usuário escolhe** sistema, só o jogo (componente nativo, §4.1) ou sem som |
| 5 | Máquinas de teste | **Windows do dono com jogos** + Fedora do dono |
| 6 | Janela compacta abrindo sozinha ao chegar pedido | Sim — mas sem efeito enquanto a sala for aberta (ADR 0028); vale se a aprovação voltar |
| — | Prioridade | **Qualidade da stream e leveza** são o diferencial (§1) |
| — | Sala | **Aberta por padrão**; aprovação vira opção (ADR 0028) |
| — | Link | **Abre no app se instalado, senão no navegador** (§14) |

Em aberto, para o D0: o notebook Fedora tem iGPU ativa além da RTX 4050? O
próprio D0 responde (`getGPUInfo`), mas saber antes ajuda a montar a matriz.
