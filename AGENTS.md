# AGENTS.md

Contexto permanente deste repositório. Leia antes de qualquer tarefa.
Commite este arquivo na raiz. Ele vale para toda sessão, de todo agente.

---

## O que é este projeto

**Tela** — plataforma de transmissão de gameplay em 1080p60 com latência sub-segundo, self-hosted, sem cadastro.

O usuário aperta um botão, ganha um link permanente (`tela.gg/jv`), manda pros amigos. Eles abrem e veem o jogo com ~150ms de atraso. Nada mais.

Contexto: desde 17/08/2026 o Discord suspendeu compartilhamento de tela no Brasil por ordem da ANPD. O Discord **continua funcionando** para texto e voz — por isso este produto **não** implementa chat, voz ou social. Os usuários já estão numa call conversando; nós entregamos só o cano de vídeo.

---

## Documentos de referência

| Arquivo | Quando ler |
|---|---|
| `docs/TELA-changeset-mesh.md` | **Leia primeiro.** Altera as decisões abaixo; em conflito, ele vence |
| `docs/adr/` | Decisões já tomadas e seus motivos — comece pela 0005 |
| `docs/TELA-documentacao-tecnica.md` | Fluxos, pipeline de mídia, UI. As partes de SFU e infra estão obsoletas |
| `docs/DEPLOY.md` | Subir o front estático e o servidor de sinalização |

O documento de padrões de engenharia citado na versão original deste arquivo
nunca existiu no repositório. As regras abaixo são a fonte.

**Em conflito, os documentos vencem sobre sua intuição.** Se discordar de uma decisão, escreva o argumento no relatório final — não a contrarie no código sem avisar.

---

## As oito regras inegociáveis

Violação de qualquer uma delas invalida o trabalho, mesmo que os testes passem.

### R1 — `apps/web/src/core/` não pode importar React

Este código será portado para Tauri (Fase 3). Se a lógica de mídia estiver em `useEffect`, a Fase 3 vira reescrita total. A lógica de captura, publicação, reconexão e stats vive em `BroadcastSession` / `ViewerSession` — classes puras com máquina de estados explícita. React só assina eventos via `useSyncExternalStore`.

### R2 — nenhum SDK de SFU no projeto

`core/` fala com `MediaTransport` e `SignalingChannel`. `livekit-client` não é
dependência: a implementação viva é `adapters/mesh-transport.ts`, e
`adapters/_reference/` é documentação — fora do tsconfig, fora do lint, fora do
bundle.

Essa fronteira já se pagou uma vez. Quando o transporte inteiro trocou de SFU
para mesh P2P (ADR 0005), `BroadcastSession` e `ViewerSession` mantiveram a
máquina de estados, as regras de mídia e a degradação por CPU. Mudou quem
implementa a porta, não quem a usa.

### R3 — o núcleo não importa infraestrutura

`apps/web/src/core/` não importa React, adapter, WebSocket nem WebRTC concreto.
`apps/signaling/src/` não importa nada do cliente. O teste de fogo: apague
`adapters/` e `core/` ainda compila.

### R4 — Erro esperado é `Result`, não `throw`

"Slug já existe" e "credencial inválida" são retornos normais. `throw` só para
bug e falha de infra. `AppError` é união de literais para que qualquer
`Record<AppError, …>` seja exaustivo por construção: acrescentar um erro quebra
a compilação até alguém decidir o que mostrar ao usuário.

Ponto conhecido em aberto: a captura de tela ainda rejeita com `CaptureError`
cru em vez de devolver `Result` (`core/ports/screen-capture.ts`). Consequência
real — `NO_TRACK` chega ao usuário como "você cancelou". Está registrado, não
esquecido.

### R5 — Quatro configurações de mídia nunca mudam sem ADR

```ts
track.contentHint = 'motion';                  // sem isso, gameplay vira slideshow
degradationPreference: 'maintain-framerate';   // perder resolução, nunca framerate
videoCodec: 'h264';                            // único com HW encode universal
// parâmetros de encoding IDÊNTICOS para todos os peers
```

A quarta é a mais importante em mesh e a que mais parece errada à primeira
vista. O Chrome reaproveita o mesmo encoder entre `RTCRtpSender`s cujos
parâmetros batem: um encode, três envios. Varie o bitrate por peer e viram três
encoders 1080p60 disputando a GPU com o jogo.

**Adaptação é coletiva, não individual.** Se um espectador tem rede ruim, ou
ele aguenta o que está sendo enviado, ou todos descem juntos um degrau. Está
implementado em `core/mesh/mesh-topology.ts` e testado — alguém vai tentar
"otimizar" isso depois; não deixe.

Corolário: a escada de degradação por CPU anda só por presets de 60fps.
`p720p30` tem a mesma resolução do `p720p60eco`, então descer até ele sob
pressão de CPU cortaria framerate sem aliviar o encoder. Ele é degrau de
UPLOAD, não de CPU.

### R6 — Escopo é fechado

**Não implemente, mesmo que pareça útil:** chat, voz, contas/login/senha/e-mail, gravação, clipes, emotes, reações, seguidores, diretório público, busca, múltiplos transmissores por sala, analytics de terceiros.

Se achar que algo disso é necessário, pare e pergunte. Não implemente "por precaução".

### R7 — Sem barrel files

Nada de `index.ts` re-exportando um módulo inteiro. Quebra tree-shaking, cria ciclos, esconde dependências. Exceção única: a API pública de `packages/shared`.

### R8 — O signaling nunca toca mídia

O servidor repassa `payload` opaco. Não parseia SDP, não inspeciona ICE, não
guarda histórico. Se você se pegar escrevendo lógica de mídia no servidor,
parou de ser mesh — e o servidor virou parte do caminho da falha.

É regra de lint, não de honra: ler `.sdp` ou `.candidate` em
`apps/signaling/src/` quebra o build.

Consequência observável, e vale conhecer: se o signaling cair no meio de uma
transmissão, as conexões já estabelecidas continuam funcionando. Só espectadores
novos não entram.

---

## Estrutura de camadas

**Web** (`apps/web/src/`)
```
core/domain/    puro, zero I/O        → só @tela/shared
core/ports/     interfaces
core/mesh/      PeerLink, MeshTopology, ICE  → sem DOM: RTCPeerConnection é injetado
core/media/     sessões, presets, stats, banda
core/identity/  ownerToken
adapters/       implementam as ports  → WebSocket, WebRTC, browser APIs
react/          hooks finos           → ponte core ↔ React via useSyncExternalStore
components/     burros, props → JSX   → zero lógica, zero core/
routes/         composição de página
container.ts    fiação                → único que importa adapters
```

**Signaling** (`apps/signaling/src/`)
```
protocol        vem de @tela/shared
channel-registry.ts  roteamento e ciclo de vida  → recebe uma interface Socket
limits.ts       rate limit e tetos
config.ts       único que lê env
server.ts       WebSocket + bootstrap
```

Regra geral: **as setas apontam para dentro**.

---

## Comandos

```bash
pnpm install
pnpm dev                                # signaling :3333 + web :5173
pnpm turbo lint typecheck test build    # tem que passar antes de qualquer entrega
pnpm depcruise                          # ciclos de dependência
```

Não há Docker, não há banco, não há servidor de mídia. O signaling é um
processo Node sem estado durável.

---

## O que você NÃO consegue verificar sozinho

Seja honesto sobre isso. Você não tem GPU, nem tela, nem `getDisplayMedia`, nem rede real.

| Não verificável por você | Quem verifica |
|---|---|
| Latência glass-to-glass | humano, com câmera a 240fps |
| Hardware encode ativo | humano, em `chrome://gpu` |
| Impacto no FPS do jogo | humano, com MangoHud |
| Áudio do sistema no Linux | humano, com sink virtual |
| Se o encoder é reaproveitado entre peers | humano, comparando FPS com 1 e com 3 espectadores |
| Taxa de sucesso de ICE em CGNAT brasileiro | humano, com amigos em operadoras diferentes |
| Consumo real da cota de TURN | humano, no painel do provedor |

Para esses pontos: escreva o código conforme os documentos, escreva o teste com `FakeTransport`, e **liste explicitamente no relatório o que precisa de validação humana e como validar**. Nunca escreva "testado e funcionando" sobre algo que você não executou.

---

## Formato de entrega

Ao fim de cada tarefa, reporte:

1. **Feito** — arquivos criados/alterados, em uma linha cada
2. **Verificado** — comandos que você rodou e a saída resumida
3. **Não verificado** — o que precisa de humano, com o passo a passo
4. **Decisões** — qualquer escolha não coberta pelos documentos, com o motivo
5. **Dúvidas** — o que você assumiu e pode estar errado

Se precisou desviar de um documento, diga qual, onde e por quê.

---

## Como trabalhar

- Um milestone por vez. Pare e reporte ao terminar. Não emende o próximo sem confirmação.
- Commits pequenos, Conventional Commits com escopo de módulo (`feat(api):`, `fix(web):`, `refactor(core):`).
- Nunca misture refatoração e mudança de comportamento no mesmo commit.
- Se um requisito estiver ambíguo, pergunte antes de escrever 300 linhas na direção errada.
- Sem `any`, sem `@ts-ignore` sem comentário justificando.
- Não invente dependência nova sem justificar; toda lib externa entra atrás de uma port.
