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
| `docs/TELA-documentacao-tecnica.md` | Arquitetura, infra, configs, fluxos, contrato de API |
| `docs/TELA-padroes-de-engenharia.md` | Camadas, ports, convenções, testes, anti-padrões |
| `docs/adr/` | Decisões já tomadas e seus motivos |

**Em conflito, os documentos vencem sobre sua intuição.** Se discordar de uma decisão, escreva o argumento no relatório final — não a contrarie no código sem avisar.

---

## As sete regras inegociáveis

Violação de qualquer uma delas invalida o trabalho, mesmo que os testes passem.

### R1 — `apps/web/src/core/` não pode importar React

Este código será portado para Tauri (Fase 3). Se a lógica de mídia estiver em `useEffect`, a Fase 3 vira reescrita total. A lógica de captura, publicação, reconexão e stats vive em `BroadcastSession` / `ViewerSession` — classes puras com máquina de estados explícita. React só assina eventos via `useSyncExternalStore`.

### R2 — `livekit-client` só existe em `apps/web/src/adapters/`

`core/` fala com a interface `MediaTransport`. Nenhum componente, hook ou rota importa LiveKit direto. Isso é o que permite trocar por WHIP na Fase 3.

### R3 — `domain/` e `application/` da API não importam infraestrutura

Sem `ioredis`, sem `livekit-server-sdk`, sem `fastify`. Só `ports/`. O teste de fogo: apague `infra/` e essas camadas ainda compilam.

### R4 — Erro esperado é `Result`, não `throw`

"Slug já existe" e "credencial inválida" são retornos normais. `throw` só para bug e falha de infra. `AppError` é union de strings literais para o mapeamento HTTP ser exaustivo.

### R5 — Três configurações de mídia nunca mudam sem ADR

```ts
track.contentHint = 'motion';                       // sem isso, gameplay vira slideshow
degradationPreference: 'maintain-framerate';        // perder resolução, nunca framerate
videoCodec: 'h264';                                 // único com HW encode universal
```

E **duas** camadas de simulcast, nunca três — cada camada é um encoder disputando CPU com o jogo.

### R6 — Escopo é fechado

**Não implemente, mesmo que pareça útil:** chat, voz, contas/login/senha/e-mail, gravação, clipes, emotes, reações, seguidores, diretório público, busca, múltiplos transmissores por sala, analytics de terceiros.

Se achar que algo disso é necessário, pare e pergunte. Não implemente "por precaução".

### R7 — Sem barrel files

Nada de `index.ts` re-exportando um módulo inteiro. Quebra tree-shaking, cria ciclos, esconde dependências. Exceção única: a API pública de `packages/shared`.

---

## Estrutura de camadas

**API** (`apps/api/src/`)
```
domain/       puro, zero I/O          → não importa nada além de @tela/shared
ports/        interfaces              → importa domain
application/  casos de uso            → importa domain + ports
infra/        adapters                → importa domain + ports
http/         rotas Fastify           → importa application + domain
composition.ts  fiação                → único que importa tudo
```

**Web** (`apps/web/src/`)
```
core/         sem React, portável     → importa core/ports
adapters/     implementam core/ports  → LiveKit, browser APIs
react/        hooks finos             → ponte core ↔ React
components/   burros, props → JSX     → zero lógica, zero core/
routes/       composição de página
```

Regra geral: **as setas apontam para dentro**.

---

## Comandos

```bash
pnpm install
pnpm dev                    # api :3333 + web :5173
pnpm turbo lint typecheck test build    # tem que passar antes de qualquer entrega
pnpm depcruise              # ciclos de dependência
docker compose -f infra/compose/docker-compose.dev.yml up -d   # livekit --dev + redis
```

LiveKit em modo `--dev` usa chave fixa `devkey` / `secret`. Nunca em produção.

---

## O que você NÃO consegue verificar sozinho

Seja honesto sobre isso. Você não tem GPU, nem tela, nem `getDisplayMedia`, nem rede real.

| Não verificável por você | Quem verifica |
|---|---|
| Latência glass-to-glass | humano, com câmera a 240fps |
| Hardware encode ativo | humano, em `chrome://gpu` |
| Impacto no FPS do jogo | humano, com MangoHud |
| Áudio do sistema no Linux | humano, com sink virtual |
| Comportamento real do simulcast | humano, com dois espectadores |

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
