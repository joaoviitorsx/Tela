# D3 — Som no Tela Desktop

**Data:** 2026-10-02 · **Tarefa:** TELA-030 · **Plano:** `PLANO-desktop.md` §4, §4.1, §15 (decisão 4) · **Antes:** D2 (captura), D4 (segundo plano)

O usuário escolhe, no passo ÁUDIO, entre três modos — **Sistema** (tudo que
toca, **menos a call**), **Só o jogo** e **Sem som** — nas duas plataformas, e a
interface mostra sempre o modo REAL: "VAI SAIR · SÓ O JOGO · Minecraft". Uma
trilha existir não diz o que está nela; quando a captura falha ou o jogo
fecha, o rótulo vira "SEM SOM · o jogo fechou" em vez de continuar prometendo.

```text
 renderer (passo ÁUDIO)                         main                          sistema
 ──────────────────────                         ────                          ───────
 SeletorDeSom (burro) ◄── useSyncExternalStore ── som-desktop.ts (loja: escolha, apps, real)
        │                                           ▲ registrar(resultado)
 semSomNaCaptura(screen)  a tela nunca leva áudio  │
 audio-desktop.ts ────── ponte.som.* (IPC) ──► som-do-app.ts ──┬─ Linux:   som-jogo-linux.ts ─► pw-loopback / pw-metadata / pw-dump
        │                                                       └─ Windows: som-jogo-windows.ts ─► utility process ─► addon C++ (WASAPI)
        └─ getUserMedia (fonte virtual)  ← Linux          └ PCM por MessagePort → AudioWorklet → trilha ← Windows
```

## 1. Modos por plataforma

| Modo | Linux (PipeWire) | Windows |
|---|---|---|
| **Sistema** — tudo menos a call | sink **Tela-Sistema** + retorno para a saída padrão (segue a padrão se trocar de fone) + fonte virtual **Tela-Sistema-Entrada**; vão para o sink **todos** os streams da saída padrão **menos** os de apps de voz e os do próprio Tela, e os que começarem a tocar depois também (§2.4) | o mesmo addon do "só o jogo" em modo **excluir**: `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` com o pid do app de voz (Discord; senão outro app de voz; senão o próprio Tela), reavaliado a cada 5 s (§3.2). Tela **ou janela** |
| **Só o jogo** | sink **Tela-Jogo** + retorno para a saída real + fonte virtual **Tela-Jogo-Entrada**; só os streams do app escolhido são movidos (§2) | addon C++ com *WASAPI process loopback* (modo **incluir**) num `utilityProcess`; PCM → `MessagePort` → `AudioWorklet` → trilha (§3) |
| **Sem som** | nenhuma trilha de áudio; a home entrega `audioDeviceId: null` | idem |

**Os apps de voz** (`src/main/som/apps-de-voz.ts`, lista fechada e testada):
Discord (estável, PTB, Canary), TeamSpeak 3 e 5, Teams, Zoom, Skype e Mumble;
no Linux também os clientes alternativos do Discord (Vesktop, WebCord,
Legcord, ArmCord) e o stream "WEBRTC VoiceEngine", que é como o Discord nativo
toca a call no PipeWire. No Windows conta o nome do executável; no Linux, o
`application.name` ou o `application.process.binary` do stream e do cliente
dele. Um app fora da lista vai junto como qualquer programa — inclusive o
Discord aberto **no navegador** (§8).

**Nenhum modo pede áudio à captura de tela** (`som-na-captura.ts`), e o main
também nunca o entrega (`respostaDeCaptura` em `fontes-de-captura.ts`): o
`audio: 'loopback'` do Electron é o sistema inteiro, com a call. Até a D3-b o
"Sistema" do Windows era esse loopback, e por isso só funcionava com a TELA
(janela era muda). Hoje o som não depende do que se captura: a superfície
passa a `desconhecido` e o aviso "só a tela inteira leva o som" não aparece.

Sem o componente de som (Windows antes da 2004, addon ausente; Linux sem as
ferramentas do PipeWire), **Sistema e Só o jogo** vêm desabilitados com o
motivo na opção, e escolher Sistema com o componente faltando bloqueia IR AO
AR ("SISTEMA · indisponível"). Nunca volta ao loopback com a call.

Padrão ao abrir, sem escolha guardada: **Sem som** (decisão do coordenador,
mantida). Antes o motivo era a call vir junto; hoje o "Sistema" a deixa de
fora, mas só a dos apps reconhecidos. A escolha é lembrada (`localStorage`
`tela.som`): sistema/nenhum como foram; do jogo, o NOME — o pid muda a cada
sessão, e o jogo volta escolhido se estiver aberto.

## 2. Linux: "só o jogo" gerenciado

### 2.1 Por que não `pactl` e por que a fonte virtual

- **`pw-dump` + `pw-metadata` + `pw-loopback`**, não `pactl`: esta máquina
  (Fedora com PipeWire) não tem `pactl` (`pulseaudio-utils` não vem), e as três
  ferramentas vêm do próprio PipeWire (`pipewire-utils`). Ausência é tratada: a
  opção "Só o jogo" vem desabilitada com "faltam: …".
- **O Chromium não lista monitores de sink.** Verificado no Electron 44 com um
  sink de verdade: `enumerateDevices()` devolveu só "Default" e o microfone.
  Esta descoberta pesou no desenho: o monitor do sink Tela-Jogo alimenta uma
  **fonte** (`Audio/Source`) — `Tela-Jogo-Entrada` — e é ela que a página
  captura. É cópia 1:1 (o pico medido nos dois pontos é idêntico). O mesmo vale
  para o modo Sistema. (O fluxo web da TELA-010, que pede para escolher
  "Monitor of …", provavelmente não mostra monitores no Chrome pelo mesmo
  motivo — não foi tocado.)

### 2.2 O que o app faz

```text
jogo ──target.object──► tela_jogo (sink; pw-loopback #1) ─ retorno ─► saída real (o jogador ouve)
                              └ monitor ─► tela_jogo_mic_cap ─► tela_jogo_mic (fonte; pw-loopback #2) ─► getUserMedia
```

1. `listar()`: `pw-dump` → streams `Stream/Output/Audio` agrupados por app
   (pid, senão nome+binário). Fora: nosso retorno e os pids do próprio Tela.
2. `iniciar(appId)`: confere o id contra uma listagem NOVA, descobre a saída
   atual do jogo pelos links (se for a padrão, o retorno **segue** a padrão; se
   a pessoa tinha escolhido outra, fica nela), sobe os dois `pw-loopback` e
   **espera** o sink com retorno ligado a uma saída e a fonte com a captura
   ligada — só então move. Se algo falhar, o jogo nunca saiu do lugar.
3. Mover = `pw-metadata <stream> target.object tela_jogo` (o que o pavucontrol
   faz). O alvo que o stream já tinha é guardado e **restaurado** (ou a chave é
   apagada) — não se desfaz a escolha manual de quem rotulou o jogo.
4. A cada 1 s (só ao vivo): streams novos do mesmo app entram no sink; os que
   sumiram saem da conta; se o app voltou com **outro pid** é reencontrado por
   nome+binário. Sem streams = "SEM SOM · …" (o sink segue de pé, silencioso).
5. `parar()`: restaura os streams (só os que ainda existem) e depois derruba a
   fonte, depois o sink (SIGTERM, SIGKILL em 1,5 s). Idempotente.

### 2.3 Reversibilidade (nada permanente)

- O sink e a fonte **pertencem aos processos** `pw-loopback`: se o app morrer
  (até `kill -9`), eles somem; os streams, cujo alvo deixou de existir, voltam
  ao padrão.
- Saída normal: `will-quit` espera `parar()` antes de sair; `SIGINT/SIGTERM/
  SIGHUP` passam por `app.quit()`; `render-process-gone` também para.
- O que sobra de uma queda feia é um `pw-loopback` órfão (kill -9 no Electron)
  e metadados `target.object=tela_jogo` — **`limparResiduos()` ao abrir o app**
  mata o órfão (só se o dono do nosso nó for mesmo um `pw-loopback`) e apaga os
  metadados que apontam para `tela_jogo`. Tudo reconhecido pelo prefixo
  `tela_jogo*` / `tela_sistema*`; nada fora dele é tocado.
- Não mexe em dispositivo do usuário nem no padrão do sistema. O WirePlumber
  guarda o **volume** por nome de app (`~/.local/state/wireplumber/
  stream-properties`) — é dele, não nosso, e só volume.
- Latência do retorno: o `pw-loopback` acrescenta algumas dezenas de ms ao que
  o JOGADOR ouve (não ao que os espectadores recebem). Se incomodar, é o ponto
  a medir (validação humana).

### 2.4 Linux: "Sistema" sem a call

```text
jogo, música, navegador… ──target.object──► tela_sistema (sink) ─ retorno ─► saída padrão (o jogador ouve tudo)
                                                  └ monitor ─► tela_sistema_cap ─► tela_sistema_mic (Tela-Sistema-Entrada) ─► getUserMedia
Discord (WEBRTC VoiceEngine) ─────────────────────────────────────────────────► saída padrão (só o jogador ouve)
```

O mesmo grafo do "só o jogo", com nomes próprios (`NOS_DO_SISTEMA` em
`grafo-pw.ts`), e a escolha invertida — `streamsDoSistema`:

- entram os streams que tocam na **saída padrão**, os que ainda não ligaram e
  não têm alvo fixado (vão para a padrão de qualquer jeito) e os que já estão
  no nosso sink;
- ficam de fora os de **apps de voz**, os do **próprio Tela** e os nossos nós;
- ficam onde estão os que a pessoa mandou para **outra saída** (o fone USB
  enquanto o jogo toca na TV): movê-los os levaria para a saída padrão no
  ouvido de quem joga. É a mesma fronteira do modo antigo, que capturava o
  monitor da saída padrão.

A varredura de 1 s move quem começar a tocar depois; a call que começar depois
nunca entra. Parar, quedas e resíduos seguem o §2.2–2.3 (os resíduos
reconhecem também `target.object=tela_sistema`).

## 3. Windows: "só o jogo" e "sistema" (componente nativo, PLANO §4.1)

```text
utilityProcess (som/utilitario-win.ts)
  └─ wasapi_loopback.node (C++, N-API, 1.1.0)
       ActivateAudioInterfaceAsync(VAD\Process_Loopback, PROCESS_LOOPBACK, pid,
                                   INCLUDE_TARGET_PROCESS_TREE  ← só o jogo
                                 | EXCLUDE_TARGET_PROCESS_TREE) ← sistema, pid = app de voz
       → IAudioClient (compartilhado, evento) → PCM float32 48 kHz estéreo, blocos de 10 ms
  └─ MessagePort ─────────────► renderer: AudioWorklet (anel ~60 ms, deriva) → MediaStreamAudioDestination → trilha
```

- **Seletor de apps:** `listarSessoes()` enumera as sessões de áudio da saída
  padrão (`IAudioSessionManager2`), uma por executável, **subidas até o
  processo-raiz** (o Chromium toca por um filho; capturar a árvore da raiz
  pega os dois), com o ícone do `.exe` (`app.getFileIcon`). A escolha é um
  `pid:<n>`; o main só captura um pid da última listagem.
- **Utility process:** se o addon cair, cai só ele; o main avisa
  (`COMPONENTE_CAIU`), a página encerra a trilha (`ended`) e mostra "SEM SOM ·
  o componente do som do jogo caiu" — o vídeo segue.
- **O PCM não passa pelo main.** `MessageChannelMain`: uma ponta vai ao utility
  (`capturar`), a outra à página (`window.postMessage` com `MARCA_DA_PORTA_SOM`,
  como a porta do `tela-captura`). A página transfere a porta direto ao
  worklet — o som não depende da thread principal da página (reserva: repasse
  bloco a bloco se o navegador recusar a transferência).
- **Silêncio:** o process loopback não entrega pacotes quando o processo está
  mudo; a thread de captura completa os intervalos com silêncio pelo relógio
  real (`steady_clock`), para o fluxo andar sempre em tempo real.
- **Formato:** pede float32 48 kHz estéreo; se o Windows recusar, tenta PCM 16
  bit, e por último float com conversão automática. Sempre sai float32.
- **Deriva de relógio** (`anel-pcm.ts`, testado com ±2000 ppm por 5 min): só toca
  com 60 ms guardados; esvaziou → silêncio e **re-enche** (um estalo só); a
  leitura anda até ±0,5% mais rápido/devagar conforme o nível sobe/desce
  (inaudível, interpolação linear); estourou o teto → joga o velho fora.
- **Requisito de sistema:** Windows 10 versão 2004 (build **19041**). A amostra
  oficial da Microsoft cita 20348 por causa da SDK dela; a API responde desde
  a 2004 (é o mínimo declarado por OBS e outros). **Não verificado aqui**
  (sem Windows) — se a 19041 falhar na prática, subir `BUILD_MINIMA_DO_WINDOWS`
  em `protocolo-som.ts` é uma constante.
- **Fallback sem silêncio enganoso:** versão antiga, `.node` ausente do pacote
  ou addon que não carrega → "Só o jogo" **desabilitado, com o motivo escrito
  na opção**. Nunca vira "Sistema" sozinho.

### 3.1 Compilação e empacotamento

- `native/wasapi-loopback/` (`binding.gyp`, `src/wasapi_loopback.cc`):
  `node-addon-api` + `node-gyp` entraram como devDependencies (só build).
- `pnpm --filter @tela/desktop native:win` (`scripts/build-wasapi.mjs`) roda
  `node-gyp rebuild --target=<Electron do package.json> --arch=x64
  --dist-url=https://electronjs.org/headers` e **carrega o `.node` no Node do
  runner** (N-API é ABI-estável): prova que o módulo abre.
- CI (`desktop.yml`, job Windows): compila antes do electron-builder, **sem
  derrubar o instalador se falhar** (`continue-on-error` + aviso + resumo do
  run: o instalador sai sem o addon e "Só o jogo" aparece desabilitado). Depois
  do empacotamento confere `resources/native/wasapi_loopback.node` e
  `resources/som/`.
- `electron-builder.yml` (`win.extraResources`): o `.node` em `resources/native`
  e o utility (`utilitario-win.js` + `protocolo-utilitario.js` + um
  `package.json` `{"type":"module"}`) em `resources/som` — **fora do asar** (o
  Node do utility lê o disco de verdade). Ausência do addon só gera um aviso do
  electron-builder (conferido numa passada de `--win --dir`).

> **O C++ não foi compilado nem executado por quem o escreveu** (sem Windows nem
> cross-compilador aqui). Foi relido contra a API documentada, e o CI é o
> primeiro compilador. Se o passo "addon WASAPI" falhar no primeiro run, o log
> dele é o ponto de partida; o resto do app não depende disso.

### 3.2 "Sistema" sem a call

- **Alvo:** ao iniciar, o main pede `listar` ao **mesmo** utility que vai
  capturar e escolhe a árvore a excluir (`alvoDaExclusao`): o Discord (tocando
  antes de calado), senão o primeiro outro app de voz, senão o **próprio
  Tela** (`process.pid`, a raiz da árvore do Electron) — sem app de voz, "tudo
  menos o Tela" é tudo. O process loopback exclui **uma** árvore por captura:
  com Discord e TeamSpeak abertos juntos, o TeamSpeak iria junto.
- **Reavaliação a cada 5 s:** o amigo entra na call depois de a transmissão
  começar. O main lista as sessões no utility vivo; se o alvo mudou, pede
  `trocar` e o utility para a captura e reabre com o alvo novo **na mesma
  porta** — a página não percebe nada além de um corte de uma ativação
  (dezenas de ms, não medido) no som. Uma listagem que falha não muda nada;
  uma troca que o Windows recusa encerra a captura (`COMPONENTE_CAIU`, "SEM SOM
  · o componente de som caiu") — nunca fica um som com a call.
- **O alvo fechar não encerra a captura:** no modo excluir o addon não espera
  o fim do processo-alvo; a próxima reavaliação passa a excluir o Tela.
- **Protocolo:** `capturar` e `trocar` carregam `modo` (`incluir`/`excluir`),
  validado no utility (`pedidoValido`) e no addon (outro valor é `TypeError`).
  O utility só pede `excluir` a um addon ≥ 1.1.0 (`addonSabeExcluir`): uma 1.0
  ignoraria o argumento e capturaria **só** a call.
- **Uma conversa por utility:** o `ProcessoUtilitario` não remove ouvintes, e
  perguntar a cada 5 s por horas com um ouvinte por pergunta seria um
  vazamento; `Conversa` (em `som-jogo-windows.ts`) tem um ouvinte só e um
  pedido por vez.

## 4. Interface (passo ÁUDIO, só no app)

`components/SeletorDeSom.tsx` (burro) + `desktop/SomDoAppDesktop.tsx`:

- três opções num `radiogroup` (setas movem a seleção; Tab entra no grupo;
  glifos ◉ ○ × além da cor). Sistema diz "Tudo que toca no seu PC, menos a
  call de voz."; sem o componente de som, Sistema e Só o jogo desabilitados
  mostram o **motivo na própria opção**;
- com "Só o jogo": lista de **programas com som** (ícone ou inicial, nome,
  TOCANDO / EM SILÊNCIO), também `radiogroup`, botão ATUALIZAR; a lista se
  atualiza a cada 3 s **só enquanto montada e com "só o jogo" escolhido** (no
  Windows cada listagem sobe um processo);
- linha `role="status"` "VAI SAIR · …" com o modo real, em tom de alerta quando
  difere do escolhido (jogo fechou, captura falhou);
- "Só o jogo" sem jogo escolhido, ou Sistema/Só o jogo sem o componente,
  **desabilita IR AO AR** e diz por quê;
- o modo real do Sistema é "SISTEMA · tudo menos a call" (sem detalhe técnico);
- o medidor da home mostra `SISTEMA / SÓ O JOGO / SEM SOM`.

A home continua igual na web: `somDoApp` é `null` em `container-transmissao.ts`
e só o container do desktop o preenche — um export de uma linha em cada
container (para o outro marco que mexe neles: `somDoApp` e `audio` são locais
em `container.desktop.ts`, e o `screen` agora passa por `comSomEscolhido`).

## 5. IPC acrescentado (`ponte.ts` é o contrato)

| Canal | Sentido | Payload |
|---|---|---|
| `tela:som-capacidades` | invoke | → `{ jogo: { disponivel, motivo } }` |
| `tela:som-listar-apps` | invoke | → `AppComSom[]` (id, nome, tocando, ícone) |
| `tela:som-iniciar-jogo` | invoke | `string` (id) → `RespostaSomJogo` (`entrada` com a descrição da fonte, ou `porta` com o id) |
| `tela:som-iniciar-sistema` | invoke | → `RespostaSomSistema` (`entrada` com a descrição da fonte no Linux, `porta` com o id no Windows) |
| `tela:som-parar` | send | — |
| `tela:som-jogo-encerrou` | main → renderer | `{ motivo }` |
| `tela:som-jogo-porta` | main → renderer | `{ id }` + `MessagePort` (Windows, "só o jogo" e "sistema") |

Todo `invoke` confere a origem do frame; o id do app passa por
`pedidoDeJogoValido` (regex) e é conferido contra a listagem.

## 6. Verificado (máquina do dono, Fedora 44, PipeWire 1.6.9, 2026-10-02)

- `pnpm --filter @tela/desktop run typecheck|lint|test|build`: ok — 227 testes
  em 18 arquivos, 97 deles em `som/` (parsers com dumps reais, comandos,
  máquina de estados contra um PipeWire de mentira, protocolo do utility,
  máquina do Windows com utility de mentira).
- `pnpm --filter @tela/web run typecheck|lint|test|build` (993 testes, 114
  arquivos) e `build:desktop`
  (`VITE_SIGNAL_URL=ws://x/signal VITE_PUBLIC_ORIGIN=https://x`): ok; o worklet
  sai como `pcm-worklet-*.js` no build do desktop e **não** entra no build web.
- `pnpm depcruise` e `pnpm test:audio-linux` (existente): ok.
- **Integração Linux** — `pnpm --filter @tela/desktop build && node
  apps/desktop/d0/audio-jogo.mjs`: cria uma saída silenciosa própria
  (`tela_teste_saida`), toca "jogo" (440 Hz) e "call" (880 Hz) nela, roda o
  MESMO código do app, grava 2 s da fonte `Tela-Jogo-Entrada` (rms 0,283; 440 Hz
  0,2000; 880 Hz 0,0001 — **só o jogo chegou**), confere que o jogo voltou à
  saída de antes e que o sink, a fonte e os metadados sumiram; depois cria e
  remove a fonte do modo Sistema. Termina com "nada sobrou no grafo" e saída 0.
- **Chromium real (Electron 44, janela oculta):** com o código do app, o
  `enumerateDevices()` lista `Tela-Jogo-Entrada` e `Tela-Sistema-Entrada`; a
  captura do primeiro entrega o mesmo pico que o monitor do sink; após `parar()`
  as duas somem da lista. Foi aqui que se achou que monitores não aparecem.
- `electron-builder --win --dir`: `resources/som/{utilitario-win.js,
  protocolo-utilitario.js,package.json}` no lugar; addon ausente só avisa.
- utility process em ESM com `Float32Array` por `MessagePortMain` e `argv`
  conferido num app Electron de teste (Linux).

### 6.1 "Sistema" sem a call (D3-b, 2026-10-02)

- `pnpm --filter @tela/desktop test` (349 testes, 30 arquivos) e
  `pnpm --filter @tela/web test` (1124 testes, 130 arquivos), o portão do repo
  (`pnpm turbo lint typecheck test build --concurrency=2`: 16 tarefas ok),
  `pnpm depcruise` (sem violações), o eslint do repo inteiro e o
  `build:desktop` da web: ok.
- **Integração Linux** — `node apps/desktop/d0/audio-jogo.mjs`, agora com a
  parte do Sistema: jogo 440 Hz, música 660 Hz e uma "call" com
  `application.name=Discord` 880 Hz tocando na saída silenciosa. O código do
  app montou `tela_sistema`, moveu jogo e música e deixou o Discord; a gravação
  de 2 s da fonte **Tela-Sistema-Entrada** deu 440 Hz 0,2001 · 660 Hz 0,2001 ·
  **880 Hz 0,0000**; `parar()` devolveu os dois streams e "nada sobrou no
  grafo". Para não mexer no som de verdade de quem roda, o modo Sistema do
  teste enxerga um `pw-dump` **isolado** (só os streams do teste, com a saída
  silenciosa no papel de padrão) e o retorno vai para ela; o grafo real e a
  padrão real não mudam.
- **Windows:** máquina de estados com utility de mentira (exclui o Discord,
  troca de alvo quando o Discord aparece e quando some, troca recusada
  encerra, parar cancela a reavaliação) e o protocolo com o modo. O C++ **não
  foi compilado** (§7).

## 7. NÃO verificado — validação humana

| O quê | Como |
|---|---|
| **Windows: só o jogo com a call aberta** (o aceite do §4.1) | Instalar a próxima beta; Discord em call + jogo; passo ÁUDIO → SÓ O JOGO → o jogo na lista → IR AO AR. Um amigo no link ouve o jogo e **não** a call; L/R preservados (um tom só no canal esquerdo, se houver) |
| O C++ compila e o addon carrega | Run do CI: passo "addon WASAPI" verde e o resumo "compilado e carregou". Senão o instalador sai com "Só o jogo" desabilitado e o motivo — copiar o texto |
| Build mínima 19041 | Se houver máquina com Windows 10 2004–20H2, "Só o jogo" deve funcionar; senão ajustar `BUILD_MINIMA_DO_WINDOWS` |
| Sincronismo A/V e 1 h sem deriva audível | Jogo + câmera a 240 fps (ou palmas/clique) comparando som e imagem no espectador; 1 h de transmissão |
| Troca de fone no meio | Trocar o dispositivo padrão com o jogo no ar: a trilha pode silenciar (`DISPOSITIVO`); anotar o que acontece |
| Fim do jogo | Fechar o jogo: o rótulo vira "SEM SOM · o jogo fechou", o vídeo segue |
| Linux com um jogo de verdade (Steam/Proton, SDL, Chromium) | Passo ÁUDIO → SÓ O JOGO; o jogo aparece na lista; ao ir ao ar o jogador **continua ouvindo** e um amigo ouve só o jogo; após encerrar, o jogo volta ao fone e `pw-cli ls Node` não tem `tela_*` |
| Linux: latência do retorno no fone do jogador | Se o som do jogo chega atrasado no fone, é o `pw-loopback` do retorno |
| Linux: jogo que abre streams depois (troca de nível) | Deve entrar no sink em ≤ 1 s; os primeiros instantes do stream novo tocam só no fone |
| Linux: `kill -9` no app e reabrir | O jogo volta ao fone sozinho; ao reabrir não sobra `tela_*` (`limparResiduos`) |
| **Windows: Sistema sem a call** (o pedido da D3-b) | Instalar a beta com o addon 1.1.0. Discord **em call** + um jogo + uma música (Spotify ou YouTube no navegador). Passo ÁUDIO → SISTEMA → IR AO AR (com TELA e depois com JANELA). Um amigo **fora da call** abre o link: ouve o jogo **e** a música, e **não** ouve a call. O rótulo diz "SISTEMA · tudo menos a call" |
| Windows: o amigo entra na call depois | Ir ao ar com Sistema e o Discord **fechado**; abrir o Discord e entrar na call. Em até ~5 s a voz some do que o amigo ouve; o jogo segue, com no máximo um corte curto. Fechar o Discord no meio: o som segue |
| Windows: o addon 1.1.0 compila e o modo excluir funciona | Run do CI: passo "addon WASAPI" verde com "carregou: versão 1.1.0". Se o Windows recusar o modo excluir, o rótulo vira "SEM SOM · o som não iniciou" — copiar o log `[tela-som]` do utility |
| Windows: Discord PTB/Canary, Teams, Zoom | Mesmo roteiro do primeiro item com cada um; o nome do executável tem de bater com a lista de `apps-de-voz.ts` |
| Linux: Sistema com o Discord de verdade | Discord nativo (ou Flatpak/Vesktop) em call + jogo + música; SISTEMA → IR AO AR. O amigo ouve jogo e música, não a call; `pw-dump` mostra o stream da call ("WEBRTC VoiceEngine", binário `Discord`) fora do `tela_sistema`. Se a call vazar, anotar o `application.name` e o `application.process.binary` do stream dela |
| Linux: Sistema e o que toca em outra saída | Jogo no fone e música no HDMI (escolhido no pavucontrol): a música **não** vai ao ar (fronteira do §2.4) |

## 8. Decisões e limites

1. **Fonte virtual em vez de monitor** (§2.1): consequência direta do Chromium
   não listar monitores. Dois `pw-loopback` por sessão em vez de um.
2. **`pw-*` em vez de `pactl`**: PipeWire é o alvo declarado (§4); PulseAudio
   puro fica de fora e a opção diz que faltam ferramentas.
3. **Padrão Sem som**, com a escolha lembrada (`tela.som`) — mantido na
   D3-b (decisão do coordenador; o texto antigo deste item, "padrão Sistema",
   estava desatualizado).
4. **Build 19041** em vez de 20348 (§3).
5. **Utility e addon fora do asar** (`extraResources`).
6. **CI não falha com o addon** (§3.1): decisão de risco consciente, com aviso.
7. Windows: o seletor lista **sessões na saída padrão**; sessões em outro
   dispositivo de saída não aparecem.
8. Linux: apps com streams em **saídas diferentes** — o retorno vai para a
   saída do primeiro stream.
9. O `AudioContext` do PCM é criado sem gesto do usuário; o Electron não bloqueia
   autoplay por padrão (`autoplayPolicy` não foi mudada).
10. O `Seletor` do passo ÁUDIO consulta o main só montado; o IPC do som não tem
    estado no main além da sessão ativa.
11. **Sistema sem a call (D3-b).** Windows: process loopback em modo excluir
    com o pid do app de voz, uma árvore por vez (Discord primeiro). Linux: o
    sink do "só o jogo" com tudo menos os apps de voz. A identificação é por
    **lista fechada** de nomes; fica de fora, e vai junto como qualquer
    programa: o Discord **no navegador** (a call sai do processo do Chrome, e
    excluir o navegador inteiro levaria junto a música dele) e apps de voz
    fora da lista.
12. **Sem fallback para o loopback.** Sem o componente, Sistema fica
    desabilitado com o motivo, como "só o jogo". Windows 10 antes da 2004 perde
    o modo Sistema que tinha (com a call) — decisão consciente: o pedido do
    dono é não transmitir a call.
13. Linux: o Sistema só move o que toca na **saída padrão** (§2.4); o que a
    pessoa mandou para outra saída não vai ao ar, como antes.
