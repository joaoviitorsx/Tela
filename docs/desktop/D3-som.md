# D3 — Som no Tela Desktop

**Data:** 2026-10-02 · **Tarefa:** TELA-030 · **Plano:** `PLANO-desktop.md` §4, §4.1, §15 (decisão 4) · **Antes:** D2 (captura), D4 (segundo plano)

O usuário escolhe, no passo ÁUDIO, entre três modos — **Sistema** (tudo que
toca, inclusive a call), **Só o jogo** e **Sem som** — nas duas plataformas, e a
interface mostra sempre o modo REAL: "VAI SAIR · SÓ O JOGO · Minecraft". Uma
trilha existir não diz o que está nela; quando a captura falha ou o jogo
fecha, o rótulo vira "SEM SOM · o jogo fechou" em vez de continuar prometendo.

```text
 renderer (passo ÁUDIO)                         main                          sistema
 ──────────────────────                         ────                          ───────
 SeletorDeSom (burro) ◄── useSyncExternalStore ── som-desktop.ts (loja: escolha, apps, real)
        │                                           ▲ registrar(resultado)
 comSomEscolhido(screen)  Sistema pede áudio à tela │
 audio-desktop.ts ────── ponte.som.* (IPC) ──► som-do-app.ts ──┬─ Linux:   som-jogo-linux.ts ─► pw-loopback / pw-metadata / pw-dump
        │                                                       └─ Windows: som-jogo-windows.ts ─► utility process ─► addon C++ (WASAPI)
        └─ getUserMedia (fonte virtual)  ← Linux          └ PCM por MessagePort → AudioWorklet → trilha ← Windows
```

## 1. Modos por plataforma

| Modo | Linux (PipeWire) | Windows |
|---|---|---|
| **Sistema** | `pw-loopback` cria a fonte virtual **Tela-Sistema-Entrada** com o monitor da saída padrão (sem alvo fixo: segue a saída padrão se trocar de fone); a página a captura como microfone | `audio: 'loopback'` do Electron, que o `setDisplayMediaRequestHandler` entrega **só quando a página pede áudio** — e só com a TELA (janela é muda; o rótulo diz) |
| **Só o jogo** | sink **Tela-Jogo** + retorno para a saída real + fonte virtual **Tela-Jogo-Entrada**; só os streams do app escolhido são movidos (§2) | addon C++ com *WASAPI process loopback* num `utilityProcess`; PCM → `MessagePort` → `AudioWorklet` → trilha (§3) |
| **Sem som** | nenhuma trilha de áudio; a home entrega `audioDeviceId: null` | idem; a captura de tela não pede áudio |

"Só o jogo" e "Sem som" **não pedem áudio à captura de tela**
(`som-na-captura.ts`): senão a call viria junto com o jogo no Windows. E
nesses dois modos uma janela deixa de disparar o aviso de "sem áudio: só a tela
inteira leva o som" (a superfície passa a `desconhecido`), porque ali a janela
é o que a pessoa quis.

Padrão ao abrir, sem escolha guardada: **Sem som** (decisão do coordenador).
"Sistema" inclui a call do Discord, e quem assiste costuma estar na mesma call:
ouviria a própria voz de volta, com atraso. A escolha é lembrada
(`localStorage` `tela.som`): sistema/nenhum como foram; do jogo, o NOME — o pid
muda a cada sessão, e o jogo volta escolhido se estiver aberto.

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

## 3. Windows: "só o jogo" (componente nativo, PLANO §4.1)

```text
utilityProcess (som/utilitario-win.ts)
  └─ wasapi_loopback.node (C++, N-API)
       ActivateAudioInterfaceAsync(VAD\Process_Loopback, PROCESS_LOOPBACK, pid, INCLUDE_TARGET_PROCESS_TREE)
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

## 4. Interface (passo ÁUDIO, só no app)

`components/SeletorDeSom.tsx` (burro) + `desktop/SomDoAppDesktop.tsx`:

- três opções num `radiogroup` (setas movem a seleção; Tab entra no grupo;
  glifos ◉ ○ × além da cor), "Só o jogo" desabilitado mostra o **motivo na
  própria opção**;
- com "Só o jogo": lista de **programas com som** (ícone ou inicial, nome,
  TOCANDO / EM SILÊNCIO), também `radiogroup`, botão ATUALIZAR; a lista se
  atualiza a cada 3 s **só enquanto montada e com "só o jogo" escolhido** (no
  Windows cada listagem sobe um processo);
- linha `role="status"` "VAI SAIR · …" com o modo real, em tom de alerta quando
  difere do escolhido (jogo fechou, captura falhou);
- "Só o jogo" sem jogo escolhido **desabilita IR AO AR** e diz por quê;
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
| `tela:som-iniciar-sistema` | invoke | → `RespostaSomSistema` (Linux) |
| `tela:som-parar` | send | — |
| `tela:som-jogo-encerrou` | main → renderer | `{ motivo }` |
| `tela:som-jogo-porta` | main → renderer | `{ id }` + `MessagePort` (Windows) |

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
| Sistema no Windows com TELA | O amigo ouve tudo (jogo + call); com JANELA o rótulo diz "SEM SOM" |

## 8. Decisões e limites

1. **Fonte virtual em vez de monitor** (§2.1): consequência direta do Chromium
   não listar monitores. Dois `pw-loopback` por sessão em vez de um.
2. **`pw-*` em vez de `pactl`**: PipeWire é o alvo declarado (§4); PulseAudio
   puro fica de fora e a opção diz que faltam ferramentas.
3. **Padrão Sistema** nas duas plataformas, sem persistência.
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
