# Prompts para o agente de desenvolvimento — Tela

> **Como usar:** copie `AGENTS.md` e os dois documentos técnicos para o repositório antes de começar (`AGENTS.md` na raiz, os outros em `docs/`). Depois envie **um milestone por vez** — não cole tudo de uma vez. Agente com sete tarefas na frente atropela as três primeiras.

---

## Setup inicial (faça você, não o agente)

```bash
mkdir tela && cd tela && git init
mkdir -p docs
# copie AGENTS.md para a raiz
# copie TELA-documentacao-tecnica.md e TELA-padroes-de-engenharia.md para docs/
git add . && git commit -m "docs: documentação de arquitetura e padrões"
```

---

## M0 — Fundação do monorepo

```
Leia AGENTS.md e docs/TELA-padroes-de-engenharia.md antes de começar.

Tarefa: montar a fundação do monorepo. Só o esqueleto — nenhuma lógica de
produto ainda.

Entregue:
1. pnpm workspaces + Turborepo com os targets: dev, build, lint, typecheck, test
2. packages/tsconfig com base.json, node.json, react.json — com as flags
   estritas listadas na seção 9 do documento de padrões (incluindo
   noUncheckedIndexedAccess e exactOptionalPropertyTypes)
3. packages/shared: schemas Zod do contrato da API (seção 6 da documentação
   técnica), presets de encoding, blocklist de slugs reservados. Tipos sempre
   derivados dos schemas com z.infer, nunca escritos à mão em duplicata.
4. apps/api e apps/web como pacotes vazios que compilam
5. eslint.config.js com eslint-plugin-boundaries configurado exatamente como
   na seção 9, incluindo as regras no-restricted-imports que proíbem:
   - ioredis/livekit-server-sdk/fastify em domain/ e application/ da API
   - livekit-client em components/ e core/ do web
   - react em core/ do web
6. .dependency-cruiser.json barrando ciclos
7. .github/workflows/ci.yml rodando lint, typecheck, test e build
8. infra/compose/docker-compose.dev.yml com livekit --dev e redis

Critério de aceite:
- `pnpm install && pnpm turbo lint typecheck build` passa limpo
- Um arquivo de teste que viole uma fronteira (ex: import de ioredis em
  domain/) faz o lint falhar. Demonstre isso e depois remova o arquivo.

Pare ao terminar e reporte no formato do AGENTS.md.
```

---

## M1 — Domínio e casos de uso da API

```
Contexto: M0 concluído. Agora a lógica de negócio da API — sem nenhuma
infraestrutura ainda.

Tarefa: implementar domain/, ports/ e application/ de apps/api.

Entregue:
1. domain/result.ts — Result<T,E> com ok() e err()
2. domain/errors.ts — AppError como union de strings literais
3. domain/slug.ts — branded type Slug + parseSlug() retornando Result +
   suggestAlternatives()
4. domain/room.ts — branded type RoomName + roomNameFor()
5. domain/broadcast.ts — constantes e regras puras
6. ports/ — SlugRepository, PresenceStore, BroadcastGateway, TokenIssuer,
   Hasher, Clock. Nenhuma assinatura pode mencionar Redis ou LiveKit.
7. application/ — um arquivo por caso de uso, cada um como factory makeXxx(deps):
   claim-slug, start-broadcast, heartbeat-broadcast, stop-broadcast,
   get-live-status, join-broadcast, handle-room-event
8. Testes unitários com fakes in-memory (não mocks) para todos os casos de uso,
   cobrindo o caminho feliz e TODOS os caminhos de erro

Restrições:
- Nenhum import de ioredis, livekit-server-sdk ou fastify nestes diretórios
- Nenhum throw para erro esperado
- Nenhum acesso a process.env

Critério de aceite:
- `pnpm turbo lint typecheck test` verde
- Os testes rodam sem nenhum container de pé
- Apagar apps/api/src/infra (que ainda nem existe) não afetaria a compilação

Pare e reporte.
```

---

## M2 — Infraestrutura e HTTP da API

```
Contexto: M1 concluído. Agora os adapters e a camada HTTP.

Tarefa: implementar infra/, http/, config.ts, composition.ts e server.ts.

Entregue:
1. config.ts — env validado com Zod, process.exit(1) se inválido. Este deve ser
   o ÚNICO lugar do codebase que lê process.env.
2. infra/redis/ — client + slug-repository.redis.ts + presence-store.redis.ts.
   Toda chave e TTL vivem aqui e em nenhum outro lugar. claim() usa HSETNX
   para atomicidade. Verificação de ownerHash com timingSafeEqual.
3. infra/livekit/ — broadcast-gateway.livekit.ts e token-issuer.livekit.ts.
   Token de publisher: canPublish true, canSubscribe FALSE (transmissor não
   baixa nada). Token de viewer: canPublish false, canPublishData false, TTL 15min.
4. http/routes/ — as sete rotas da seção 6 da documentação técnica. Cada handler
   tem no máximo 5 linhas de corpo: chamar caso de uso, mapear erro, retornar.
   Zero lógica de negócio, zero acesso a Redis.
5. http/error-mapping.ts — Record<AppError, {status, message}> exaustivo
6. http/plugins/ — rate limit conforme a tabela da seção 6, cors, error handler
   global, logger com redact de ownerToken e token
7. Webhook do LiveKit com verificação de assinatura via WebhookReceiver
8. composition.ts — fiação única, tipada, decorando a instância Fastify
9. Testes de contrato com app.inject() cobrindo status e formato de resposta

Restrições:
- Nenhuma regra de negócio em http/
- Nenhum ownerToken em log, URL ou query string
- room.auto_create fica false; só a API cria sala

Critério de aceite:
- Com docker-compose.dev.yml de pé: POST /api/claim, /api/broadcast/start e
  /api/join/:slug funcionam via curl. Cole os comandos e as respostas.
- GET /api/health retorna redis e livekit true

Pare e reporte.
```

---

## M3 — Núcleo de mídia do web

```
Contexto: M2 concluído. Este é o milestone mais importante do projeto — leia
a seção 5 do documento de padrões inteira antes de escrever qualquer linha.

Tarefa: implementar apps/web/src/core/ e apps/web/src/adapters/.

Entregue:
1. core/ports/media-transport.ts — interface MediaTransport, sem nenhuma
   menção a LiveKit
2. core/ports/screen-capture.ts e audio-capture.ts
3. core/media/broadcast-session.ts — classe com máquina de estados explícita
   (union discriminada: idle | requesting-capture | connecting | live |
   reconnecting | ended). Estados impossíveis não podem ser representáveis.
   Aqui moram contentHint='motion', a escolha de preset e o publish.
4. core/media/viewer-session.ts — inclui playoutDelayHint=0 e
   jitterBufferTarget=0 quando disponíveis
5. core/media/stats-sampler.ts — leitura de RTCStats, expõe fps, bitrate, rtt
   e qualityLimitationReason
6. core/media/presets.ts — 1080p60 e 720p60, DUAS camadas de simulcast cada
7. core/identity/owner-token.ts — geração de 32 bytes com crypto.getRandomValues,
   persistência via port de storage
8. core/api/client.ts — cliente HTTP tipado que valida respostas com os schemas
   de @tela/shared
9. adapters/livekit-transport.ts implementando MediaTransport
10. adapters/browser-screen-capture.ts e browser-audio-capture.ts (áudio com
    echoCancellation, noiseSuppression e autoGainControl todos false)
11. Testes de BroadcastSession e ViewerSession com FakeTransport, cobrindo
    todas as transições de estado

Restrições absolutas:
- Nenhum import de react, react-dom ou zustand em core/
- Nenhum import de livekit-client fora de adapters/
- degradationPreference sempre 'maintain-framerate'
- Nunca três camadas de simulcast

Critério de aceite:
- Testes de sessão rodam sem browser, sem servidor, em milissegundos
- Um import de React em core/ faz o lint falhar (demonstre e reverta)
- Explique no relatório, em 3 linhas, como trocar LiveKit por WHIP na Fase 3
  sem tocar em broadcast-session.ts

Pare e reporte.
```

---

## M4 — Interface

```
Contexto: M3 concluído. Agora a camada React.

Leia a seção 11 da documentação técnica (UI/UX) e a seção 5.3–5.4 do documento
de padrões.

Tarefa: implementar react/, components/, routes/ e styles/.

Entregue:
1. styles/globals.css com os tokens @theme do Tailwind v4 exatamente como
   especificado (void, surface, line, muted, text, accent, danger)
2. react/use-broadcast.ts, use-viewer.ts, use-media-stats.ts, use-live-status.ts
   — hooks finos usando useSyncExternalStore. Zero lógica.
3. components/ — BigButton, LiveHud, StatsBadge, AudioUnlock, OfflineState,
   SlugPicker. Todos sem useState, sem useEffect, sem import de core/.
4. routes/Home.tsx — um botão e um campo. Sem header, sem logo, sem rodapé.
   Validação de slug com debounce de 300ms.
5. routes/Broadcast.tsx — HUD no canto superior que some após 5s e volta no
   mousemove. Link copiado automaticamente ao iniciar. Quando
   qualityLimitationReason mudar, mostrar o motivo real ao usuário
   ("CPU no limite — reduzindo para 720p").
6. routes/Viewer.tsx — vídeo em 100% da viewport, autoplay muted obrigatório,
   overlay grande de "clique para ativar o som" que some no primeiro clique
   em qualquer ponto. Controles somem em 2s. Atalhos: duplo clique e F para
   fullscreen, Espaço para mudo.
7. Estado offline com polling de 5s e backoff até 30s, conectando sozinho
   quando entrar ao vivo
8. Detalhes: Wake Lock durante transmissão, título da aba vira "● tela.gg/jv",
   sendBeacon no beforeunload, números em fonte monoespaçada

Restrições:
- Nenhum componente importa livekit-client nem recebe objeto Room como prop
- Nenhuma duplicação do estado da sessão em store — a sessão é a fonte da verdade
- Nada mais arredondado que 8px, sem sombras, sem gradientes
- Anti-referência visual: Zoom, Teams, Meet

Critério de aceite:
- `pnpm build` gera bundle; reporte o tamanho gzipped
- Descreva o fluxo completo em 3 cliques a partir da home

Pare e reporte.
```

---

## M5 — Deploy e operação

```
Contexto: M4 concluído. Agora a infra de produção.

Tarefa: implementar infra/ conforme a seção 12 da documentação técnica.

Entregue:
1. infra/compose/docker-compose.yml — caddy, livekit, api, redis. LiveKit e
   Caddy em network_mode host. Redis com bind em 127.0.0.1.
2. infra/livekit/livekit.yaml — udp_port 7882 (porta única multiplexada),
   use_external_ip true, auto_create false, TURN embutido, prometheus_port
3. infra/caddy/Caddyfile — /rtc, /api, SPA fallback com try_files,
   Permissions-Policy com display-capture=(self)
4. infra/scripts/bootstrap.sh — Ubuntu 24.04, Docker, tuning de sysctl
   (rmem_max/wmem_max), geração de segredo
5. infra/scripts/firewall.sh — ufw com 7882/udp e 3478/udp abertos
6. infra/scripts/audio-linux.sh — sink virtual PipeWire para Fedora
7. apps/api/Dockerfile multi-stage, imagem final sem devDependencies
8. infra/.env.example completo
9. docs/RUNBOOK.md com as duas árvores de decisão da seção 13

Restrições:
- Nenhum segredo commitado
- Não coloque o LiveKit sob Docker Swarm ou Dokploy — rede overlay quebra o ICE

Critério de aceite:
- `docker compose config` valida sem erro
- Liste, em ordem, os passos para subir numa VM nova em São Paulo
- Liste as portas que precisam abrir no firewall do provedor (além do ufw)

Pare e reporte.
```

---

## Prompts auxiliares

### Revisão de arquitetura

```
Audite o repositório contra AGENTS.md e docs/TELA-padroes-de-engenharia.md.

Verifique especificamente:
- Alguma import atravessa fronteira de camada?
- core/ do web tem alguma referência a React?
- livekit-client aparece fora de adapters/?
- Algum throw para erro esperado?
- process.env fora de config.ts?
- Barrel files?
- contentHint='motion' e degradationPreference preservados?
- Três camadas de simulcast em algum lugar?
- ownerToken em log, URL ou query string?

Para cada violação: arquivo, linha, por que é problema aqui, correção.
Não corrija ainda — só reporte.
```

### Antes de qualquer PR

```
Rode `pnpm turbo lint typecheck test build` e `pnpm depcruise`.
Percorra o checklist da seção 14 do documento de padrões, item por item.
Reporte cada item como OK, N/A ou o que falta.
Só então abra o PR.
```

### Quando o agente sugerir uma feature fora do escopo

```
Isso está na lista R6 do AGENTS.md (escopo fechado). Não implemente.
Se você acha que o produto precisa disso, escreva o argumento em
docs/adr/ como proposta e siga o milestone atual.
```

---

## Ordem de execução e portões

```
M0 → M1 → M2 → [ SPIKE DE LATÊNCIA — você, não o agente ] → M3 → M4 → M5
```

O spike da Fase 0 é **bloqueante e humano**: suba o LiveKit num servidor em São Paulo, publique 1080p60, meça glass-to-glass com câmera a 240fps. Se der acima de 350ms, o problema é infra e nenhuma linha de M3/M4 resolve.

Um agente não consegue fazer essa medição. Não peça que ele finja que fez.
