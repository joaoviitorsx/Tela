# Tela — Documentação Técnica

> Streaming de gameplay 1080p60 sub-segundo, self-hosted, sem cadastro.
> Versão 1.0 — Agosto/2026

---

## Sumário

1. [Visão e escopo](#1-visão-e-escopo)
2. [Requisitos e métricas de aceite](#2-requisitos-e-métricas-de-aceite)
3. [Stack](#3-stack)
4. [Arquitetura](#4-arquitetura)
5. [Modelo de dados](#5-modelo-de-dados)
6. [Contrato da API](#6-contrato-da-api)
7. [Esqueleto do repositório](#7-esqueleto-do-repositório)
8. [Código-chave](#8-código-chave)
9. [Pipeline de mídia](#9-pipeline-de-mídia)
10. [Áudio do jogo no Linux](#10-áudio-do-jogo-no-linux)
11. [UI/UX](#11-uiux)
12. [Self-hosting](#12-self-hosting)
13. [Runbook operacional](#13-runbook-operacional)
14. [Custos](#14-custos)
15. [Segurança e LGPD](#15-segurança-e-lgpd)
16. [Roadmap](#16-roadmap)
17. [Fase 3 — App nativo (Tauri)](#17-fase-3--app-nativo-tauri)
18. [Testes e benchmark](#18-testes-e-benchmark)

---

## 1. Visão e escopo

### Problema

Desde 17/08/2026 o Discord suspendeu compartilhamento de tela e vídeo no Brasil por medida preventiva da ANPD. O caso de uso "mostrar meu gameplay pros amigos enquanto a gente conversa" ficou órfão. Alternativas atuais: Twitch/YouTube (latência 3–15s, inviável pra interação), Meet/Jitsi (UX de reunião corporativa), Parsec (foco em controle remoto, não em audiência).

### Proposta

Um cano de vídeo. Você aperta um botão, ganha um link permanente, manda pros amigos. Eles abrem e veem seu jogo em 1080p60 com ~150ms de atraso. Nada mais.

### Decisão fundadora: não construir o social

O Discord **continua funcionando** no Brasil para texto, DMs, servidores e canais de voz — a suspensão foi cirúrgica sobre vídeo. Seus usuários já estão numa call conversando. Portanto:

**Dentro do escopo:**
- Captura de tela/janela em 1080p60
- Áudio do jogo (opcional, do sistema)
- Link permanente e estável por usuário
- Página de espectador minimalista
- Self-hosting documentado

**Fora do escopo (permanentemente):**
- Chat de texto, voz, VoIP
- Contas, senhas, e-mail, OAuth
- Salas com múltiplos transmissores
- Gravação, VOD, clipes
- Descoberta pública, diretório, categorias
- Emotes, seguidores, doações

Cada item da segunda lista que você adicionar transforma o produto em "mais um Discord ruim". A força do projeto está na recusa.

### Não-objetivos técnicos

- Não escalar pra milhares de espectadores (isso é HLS/CDN, outro produto)
- Não suportar navegadores fora de Chromium/Firefox recentes
- Não funcionar sem UDP (fallback TCP existe, mas com latência degradada e avisada)

---

## 2. Requisitos e métricas de aceite

### Funcionais

| ID | Requisito |
|---|---|
| RF-01 | Transmissor inicia broadcast em ≤3 interações a partir da home |
| RF-02 | Link de compartilhamento é copiado automaticamente ao iniciar |
| RF-03 | Link é estável entre sessões (mesmo slug sempre) |
| RF-04 | Espectador abre o link e vê vídeo sem nenhum clique além do "ativar áudio" |
| RF-05 | Espectador que abre link offline vê estado claro, não erro |
| RF-06 | Transmissor vê contagem de espectadores em tempo real |
| RF-07 | Espectador com rede ruim recebe camada inferior automaticamente |
| RF-08 | Nenhum fluxo exige e-mail, senha ou dado pessoal |

### Não-funcionais — os números que definem sucesso

| Métrica | Alvo | Limite aceitável | Como medir |
|---|---|---|---|
| Latência glass-to-glass | ≤200ms | 350ms | Cronômetro + câmera 240fps (§18) |
| Framerate sustentado | 60fps | 55fps p95 | `RTCStatsReport.framesPerSecond` |
| Frames dropped no encoder | 0% | <1% em 10min | `qualityLimitationReason` |
| Impacto no FPS do jogo | <5% | 10% | Benchmark com/sem transmissão |
| Tempo até primeiro frame (viewer) | <1,5s | 3s | Marca de tempo no client |
| Taxa de conexão bem-sucedida | >98% | 95% | Telemetria de falha ICE |
| CPU do SFU com 10 viewers | <15% | 30% | Métricas Prometheus do LiveKit |

**Regra:** se a Fase 0 (spike) não bater ≤350ms, pare e resolva infra antes de escrever produto. Nenhuma quantidade de código de aplicação corrige latência de rede.

---

## 3. Stack

### Escolhas finais

| Camada | Tecnologia | Versão |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | pnpm 10 |
| Front | React 19 + Vite 7 + TypeScript 5.7 | — |
| Estilo | Tailwind CSS v4 | — |
| Estado | Zustand | 5.x |
| Cliente WebRTC | `livekit-client` | 2.x |
| API | Node 22 LTS + Fastify 5 + TypeScript | — |
| Validação | Zod 4 | — |
| SFU | **LiveKit Server** (self-hosted) | 1.8+ |
| TURN | LiveKit embedded TURN | — |
| Estado efêmero | Redis 8 | — |
| Proxy/TLS | Caddy 2 | — |
| Runtime container | Docker + Compose | — |
| Desktop (Fase 3) | Tauri 2 + Rust | — |
| CI | GitHub Actions | — |

### Justificativa das decisões difíceis

**LiveKit vs mediasoup vs MediaMTX**

| | LiveKit | mediasoup | MediaMTX |
|---|---|---|---|
| Linguagem | Go (binário) | Node/C++ (addon) | Go (binário) |
| Simulcast | Nativo, com seleção automática | Manual, você implementa | Não tem |
| Congestion control | Nativo (server-side BWE) | Você implementa | Básico |
| SDK cliente | Pronto, maduro | Você escreve o wrapper | WHEP puro |
| TURN | Embutido | Externo (coturn) | Externo |
| Esforço até MVP | ~3 dias | ~3 semanas | ~1 dia |

**Escolha: LiveKit.** O diferencial não é ser "mais fácil" — é o **simulcast com seleção server-side**. Sem isso, o amigo no 4G força a queda de qualidade pra todo mundo (o transmissor reduz o bitrate porque o pior receptor reclama). Com simulcast, cada espectador recebe a camada que aguenta e ninguém estraga a experiência dos outros. Pra "amigos com internet brasileira variada", isso não é otimização, é requisito.

mediasoup seria a escolha se você precisasse de controle absoluto sobre o roteamento (ex: transcodificação custom). Você não precisa. MediaMTX é excelente pro spike da Fase 0 — sobe em 30 segundos — mas a ausência de simulcast o desqualifica pra produção.

**Por que não coturn separado:** o LiveKit tem TURN embutido que compartilha o mesmo processo e a mesma config de IP externo. Um serviço a menos, uma fonte de bug a menos. Coturn só se você precisar de TURN independente para outros produtos.

**Por que Redis e não Postgres:** todo o estado do v1 é efêmero ou quase (slug → dono, presença, sala ativa). Postgres entra quando/se houver preferências persistentes por usuário. Não antecipe.

**Por que Fastify e não Express/NestJS:** a API tem ~400 linhas. NestJS traria 300KB de decorators pra 5 endpoints. Fastify tem validação por schema nativa e o melhor throughput do ecossistema Node.

**Por que Tauri e não Electron (Fase 3):** binário de ~8MB vs ~120MB, consumo de RAM ~40MB vs ~250MB. Num app que roda **junto com um jogo**, cada MB de RAM e cada ciclo de CPU importa. O custo é escrever a captura em Rust em vez de reaproveitar APIs do Chromium.

---

## 4. Arquitetura

### Visão geral

```
┌─────────────────────────────────────────────────────────────────┐
│                        TRANSMISSOR                              │
│  Browser (Fase 1) ou App Tauri (Fase 3)                         │
│                                                                 │
│  getDisplayMedia / PipeWire ──► encode H.264 (HW) ──► WebRTC   │
└──────────────┬──────────────────────────────────┬───────────────┘
               │ HTTPS (token)                    │ WebRTC/UDP 7882
               ▼                                  ▼
┌──────────────────────────┐        ┌─────────────────────────────┐
│    Caddy :443            │        │   LiveKit SFU               │
│  ├─ /     → web (static) │        │   ├─ :7880 signaling (ws)   │
│  ├─ /api  → api :3333    │◄──────►│   ├─ :7881 ICE/TCP fallback │
│  └─ /rtc  → livekit :7880│        │   ├─ :7882 mídia UDP (mux)  │
└──────────┬───────────────┘        │   └─ TURN :3478 / :5349     │
           │                        └──────────┬──────────────────┘
           ▼                                   │
┌──────────────────────────┐                   │ simulcast
│   API Fastify :3333      │                   │ (1080p60 / 720p30)
│  ├─ claim slug           │                   ▼
│  ├─ emitir token         │        ┌─────────────────────────────┐
│  ├─ resolver slug→room   │        │      ESPECTADORES (1..12)   │
│  └─ webhook LiveKit      │        │   Browser — página /:slug    │
└──────────┬───────────────┘        └─────────────────────────────┘
           │
           ▼
   ┌───────────────┐
   │   Redis 8     │  slug→dono, presença, sala ativa
   └───────────────┘
```

### Fluxo 1 — Primeiro acesso do transmissor

```
1. Browser abre /  →  não há identidade no localStorage
2. Front gera ownerToken = crypto.randomUUID() + 32 bytes random (base64url)
3. Guarda em localStorage['tela.owner']
4. Usuário digita slug desejado ("jv")
5. POST /api/claim { slug: "jv", ownerToken }
6. API: SETNX slug:jv { ownerHash: sha256(ownerToken), createdAt }
   ├─ sucesso → 201, slug reservado por 180 dias (renovado a cada uso)
   └─ já existe → 409, sugere alternativas (jv2, jvbr, jv-plays)
7. Front guarda localStorage['tela.slug'] = "jv"
```

Não há senha, não há e-mail. O `ownerToken` **é** a credencial. Perdeu o localStorage, perdeu o slug — trade-off consciente e comunicado na UI ("salve seu link de recuperação").

### Fluxo 2 — Iniciar transmissão

```
1. Clique em "Transmitir"
2. POST /api/broadcast/start { ownerToken }
   → API valida sha256(ownerToken) contra slug:jv
   → API cria room "b_jv" no LiveKit (RoomService.createRoom)
   → API emite AccessToken JWT (canPublish: true, ttl 6h)
   → SET live:jv { room, startedAt } EX 30  (heartbeat renova)
   → retorna { token, wsUrl, room, shareUrl: "https://tela.gg/jv" }
3. Front: navigator.mediaDevices.getDisplayMedia(...)
4. Front: room.connect(wsUrl, token) → publishTrack(...)
5. Front: navigator.clipboard.writeText(shareUrl)
6. Heartbeat a cada 10s: POST /api/broadcast/ping
```

### Fluxo 3 — Espectador

```
1. Abre https://tela.gg/jv
2. GET /api/live/jv
   ├─ offline → renderiza estado "JV está offline" + polling a cada 5s
   └─ online  → segue
3. POST /api/join/jv
   → API emite AccessToken (canPublish: false, canSubscribe: true, ttl 15min)
   → identity: "v_" + nanoid(8)   (anônimo, descartável)
4. room.connect() → autoSubscribe
5. Primeiro frame → remove overlay de loading, mantém overlay de áudio
6. Clique em qualquer lugar → video.muted = false
```

### Fluxo 4 — Presença via webhook

Polling de contagem de espectadores é desperdício. O LiveKit emite webhooks:

```
LiveKit ──POST /api/livekit/webhook──► API
  eventos: room_started, room_finished,
           participant_joined, participant_left

API atualiza Redis:
  viewers:b_jv (SET de identities, EXPIRE 3600)

Transmissor recebe a contagem pelo DataChannel do próprio LiveKit
(room.on(RoomEvent.ParticipantConnected)) — zero requisição extra.
```

O webhook é para o **servidor** saber. O transmissor já sabe pelo SDK.

---

## 5. Modelo de dados

Tudo em Redis. Nenhuma tabela relacional no v1.

| Chave | Tipo | TTL | Conteúdo |
|---|---|---|---|
| `slug:{slug}` | Hash | 180d (renovado) | `ownerHash`, `createdAt`, `lastSeenAt` |
| `live:{slug}` | Hash | 30s (heartbeat) | `room`, `startedAt`, `publisherId` |
| `viewers:{room}` | Set | 1h | identities dos espectadores conectados |
| `rl:{ip}:{rota}` | String | 60s | contador de rate limit |

```ts
// packages/shared/src/schemas.ts
export const SlugRecord = z.object({
  ownerHash: z.string().length(64),   // sha256 hex
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
});

export const LiveRecord = z.object({
  room: z.string(),
  startedAt: z.number().int(),
  publisherId: z.string(),
});
```

**Slug — regras de validação:**
```
/^[a-z0-9][a-z0-9-]{1,23}[a-z0-9]$/
```
- 3 a 25 caracteres, minúsculas, dígitos e hífen
- Não pode começar/terminar com hífen
- Blocklist de rotas reservadas: `api`, `rtc`, `admin`, `sobre`, `assets`, `_`, `favicon.ico`, `robots.txt`, `sitemap.xml`
- Blocklist de termos ofensivos (lista simples em `packages/shared/src/blocklist.ts`)

**Nomenclatura de room:** `b_{slug}` — o prefixo evita colisão com salas administrativas e facilita filtro nas métricas.

---

## 6. Contrato da API

Base: `https://tela.gg/api`

### `POST /claim`
Reivindica um slug.

```jsonc
// req
{ "slug": "jv", "ownerToken": "base64url-43-chars" }
// 201
{ "slug": "jv", "shareUrl": "https://tela.gg/jv" }
// 409
{ "error": "SLUG_TAKEN", "suggestions": ["jv2", "jvbr", "jv-plays"] }
// 400
{ "error": "SLUG_INVALID", "message": "Use 3–25 caracteres..." }
```

### `POST /broadcast/start`
Inicia transmissão. Idempotente: chamar de novo com transmissão ativa retorna o mesmo room com token novo.

```jsonc
// req
{ "ownerToken": "..." }
// 200
{
  "token": "eyJhbGci...",
  "wsUrl": "wss://tela.gg/rtc",
  "room": "b_jv",
  "shareUrl": "https://tela.gg/jv"
}
// 401 → OWNER_INVALID
```

### `POST /broadcast/ping`
Heartbeat. Renova `live:{slug}` por 30s. Chamar a cada 10s.

```jsonc
{ "ownerToken": "..." }  →  { "ok": true, "viewers": 4 }
```

### `POST /broadcast/stop`
```jsonc
{ "ownerToken": "..." }  →  { "ok": true }
```
Chama `RoomService.deleteRoom` e apaga `live:{slug}`. Também disparado por `navigator.sendBeacon` no `beforeunload`.

### `GET /live/:slug`
Público, sem autenticação. Cacheável por 2s.

```jsonc
// 200 online
{ "live": true, "startedAt": 1755900000, "viewers": 4 }
// 200 offline (não é 404 — o slug pode existir)
{ "live": false }
```

### `POST /join/:slug`
Emite token de espectador.

```jsonc
// req
{}   // nenhum dado do usuário
// 200
{ "token": "eyJ...", "wsUrl": "wss://tela.gg/rtc", "room": "b_jv" }
// 404 → NOT_LIVE
// 429 → RATE_LIMITED
```

### `POST /livekit/webhook`
Interno. Autenticado pela assinatura do LiveKit (`WebhookReceiver`). Nunca exposto sem verificação.

### `GET /health`
```jsonc
{ "ok": true, "redis": true, "livekit": true, "version": "1.0.0" }
```

### Rate limits

| Rota | Limite |
|---|---|
| `POST /claim` | 5/hora por IP |
| `POST /join/:slug` | 20/min por IP |
| `POST /broadcast/start` | 10/min por IP |
| `POST /broadcast/ping` | 12/min por owner |

---

## 7. Esqueleto do repositório

```
tela/
├── apps/
│   ├── web/                            # React + Vite
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx                 # router
│   │   │   ├── routes/
│   │   │   │   ├── Home.tsx            # botão único + claim de slug
│   │   │   │   ├── Broadcast.tsx       # HUD ao vivo
│   │   │   │   ├── Viewer.tsx          # /:slug — player
│   │   │   │   └── NotFound.tsx
│   │   │   ├── components/
│   │   │   │   ├── BigButton.tsx
│   │   │   │   ├── LiveHud.tsx         # link, viewers, bitrate, stop
│   │   │   │   ├── StatsBadge.tsx      # 1080p60 · 7.4 Mbps · 142ms
│   │   │   │   ├── AudioUnlock.tsx     # overlay "clique pra ouvir"
│   │   │   │   ├── OfflineState.tsx
│   │   │   │   └── SlugPicker.tsx
│   │   │   ├── lib/
│   │   │   │   ├── api.ts              # cliente tipado da API
│   │   │   │   ├── identity.ts         # ownerToken no localStorage
│   │   │   │   ├── publisher.ts        # captura + publish (§8.3)
│   │   │   │   ├── subscriber.ts       # connect + attach + playoutDelay
│   │   │   │   ├── stats.ts            # leitura de RTCStats
│   │   │   │   └── audio-linux.ts      # detecção de monitor PipeWire
│   │   │   ├── store/
│   │   │   │   └── broadcast.ts        # zustand
│   │   │   └── styles/
│   │   │       └── globals.css         # tokens Tailwind v4 (@theme)
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   ├── api/                            # Fastify
│   │   ├── src/
│   │   │   ├── server.ts               # bootstrap, plugins, listen
│   │   │   ├── routes/
│   │   │   │   ├── claim.ts
│   │   │   │   ├── broadcast.ts        # start / ping / stop
│   │   │   │   ├── live.ts             # GET /live/:slug
│   │   │   │   ├── join.ts
│   │   │   │   ├── webhook.ts
│   │   │   │   └── health.ts
│   │   │   ├── services/
│   │   │   │   ├── livekit.ts          # RoomServiceClient + AccessToken
│   │   │   │   ├── slug.ts             # claim, validate, verify owner
│   │   │   │   └── presence.ts         # live state + viewers
│   │   │   ├── lib/
│   │   │   │   ├── redis.ts
│   │   │   │   ├── config.ts           # env validado com zod
│   │   │   │   └── errors.ts
│   │   │   └── plugins/
│   │   │       ├── rate-limit.ts
│   │   │       └── cors.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── desktop/                        # Fase 3 — Tauri 2
│       ├── src-tauri/
│       │   ├── src/
│       │   │   ├── main.rs
│       │   │   ├── capture/
│       │   │   │   ├── mod.rs
│       │   │   │   ├── linux_pipewire.rs
│       │   │   │   ├── windows_dxgi.rs
│       │   │   │   └── macos_sck.rs     # ScreenCaptureKit
│       │   │   ├── encoder/
│       │   │   │   ├── nvenc.rs
│       │   │   │   ├── vaapi.rs
│       │   │   │   └── qsv.rs
│       │   │   ├── audio/
│       │   │   │   └── loopback.rs
│       │   │   ├── rtc.rs               # webrtc-rs / libwebrtc
│       │   │   └── tray.rs
│       │   ├── Cargo.toml
│       │   └── tauri.conf.json
│       └── src/                         # UI reaproveitada de apps/web
│
├── packages/
│   ├── shared/
│   │   └── src/
│   │       ├── schemas.ts              # zod: requests, responses, records
│   │       ├── encoding.ts             # presets de bitrate/simulcast
│   │       ├── blocklist.ts
│   │       └── index.ts
│   └── tsconfig/
│       ├── base.json
│       ├── react.json
│       └── node.json
│
├── infra/
│   ├── compose/
│   │   ├── docker-compose.yml          # produção
│   │   └── docker-compose.dev.yml      # local: livekit + redis só
│   ├── livekit/
│   │   └── livekit.yaml
│   ├── caddy/
│   │   └── Caddyfile
│   ├── scripts/
│   │   ├── bootstrap.sh                # provisiona VM do zero
│   │   ├── firewall.sh                 # ufw
│   │   ├── audio-linux.sh              # cria sink virtual PipeWire
│   │   └── latency-test.sh
│   └── .env.example
│
├── docs/
│   ├── ARQUITETURA.md
│   ├── SELF-HOSTING.md
│   ├── RUNBOOK.md
│   ├── UI-SPEC.md
│   └── DECISOES.md                     # ADRs
│
├── .github/workflows/
│   ├── ci.yml                          # lint + typecheck + test
│   └── deploy.yml                      # build + push imagens
│
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
├── .gitignore
├── LICENSE
└── README.md
```

### Arquivos de raiz

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

```jsonc
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev":       { "cache": false, "persistent": true },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":      {},
    "test":      { "dependsOn": ["^build"] }
  }
}
```

```bash
# infra/.env.example
DOMAIN=tela.gg
LIVEKIT_API_KEY=APIxxxxxxxxxxxx
LIVEKIT_API_SECRET=            # openssl rand -base64 36
LIVEKIT_URL=ws://livekit:7880  # interno; público é wss://$DOMAIN/rtc
LIVEKIT_WEBHOOK_KEY=APIxxxxxxxxxxxx
REDIS_URL=redis://redis:6379
API_PORT=3333
PUBLIC_BASE_URL=https://tela.gg
MAX_VIEWERS=12
SLUG_TTL_DAYS=180
```

---

## 8. Código-chave

### 8.1 Serviço LiveKit (API)

```ts
// apps/api/src/services/livekit.ts
import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { config } from '../lib/config.js';

const { LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = config;

export const rooms = new RoomServiceClient(
  config.LIVEKIT_HTTP_URL, key, secret,
);

export const webhooks = new WebhookReceiver(key, secret);

export async function publisherToken(room: string, identity: string) {
  const at = new AccessToken(key, secret, {
    identity,
    ttl: '6h',
    metadata: JSON.stringify({ role: 'publisher' }),
  });
  at.addGrant({
    room,
    roomJoin: true,
    roomCreate: true,
    canPublish: true,
    canSubscribe: false,        // transmissor não baixa nada — economiza banda
    canPublishData: true,
  });
  return await at.toJwt();      // async na v2 do SDK
}

export async function viewerToken(room: string, identity: string) {
  const at = new AccessToken(key, secret, { identity, ttl: '15m' });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish: false,          // espectador nunca publica
    canSubscribe: true,
    canPublishData: false,      // sem chat, sem canal de dados
    canUpdateOwnMetadata: false,
  });
  return await at.toJwt();
}

export async function ensureRoom(room: string) {
  await rooms.createRoom({
    name: room,
    emptyTimeout: 120,          // some 2min após o último sair
    departureTimeout: 20,
    maxParticipants: config.MAX_VIEWERS + 1,
  });
}
```

**Detalhe que importa:** `canSubscribe: false` no transmissor. Por padrão o SDK inscreve todo mundo em todo mundo. Como o transmissor não precisa receber nada, desligar isso evita tráfego de download inútil durante o jogo.

### 8.2 Claim de slug

```ts
// apps/api/src/services/slug.ts
import { createHash, timingSafeEqual } from 'node:crypto';
import { redis } from '../lib/redis.js';
import { RESERVED, OFFENSIVE } from '@tela/shared';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,23}[a-z0-9]$/;
const TTL = 180 * 24 * 3600;

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export function validateSlug(slug: string) {
  if (!SLUG_RE.test(slug)) return 'SLUG_INVALID';
  if (RESERVED.has(slug) || OFFENSIVE.has(slug)) return 'SLUG_RESERVED';
  return null;
}

export async function claim(slug: string, ownerToken: string) {
  const ok = await redis.hsetnx(`slug:${slug}`, 'ownerHash', hash(ownerToken));
  if (!ok) return false;
  await redis.hset(`slug:${slug}`, 'createdAt', Date.now(), 'lastSeenAt', Date.now());
  await redis.expire(`slug:${slug}`, TTL);
  return true;
}

export async function verifyOwner(slug: string, ownerToken: string) {
  const stored = await redis.hget(`slug:${slug}`, 'ownerHash');
  if (!stored) return false;
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(hash(ownerToken), 'hex');
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  // renova o TTL em cada uso — slug ativo nunca expira
  await redis.hset(`slug:${slug}`, 'lastSeenAt', Date.now());
  await redis.expire(`slug:${slug}`, TTL);
  return true;
}
```

`HSETNX` é atômico — resolve corrida de dois usuários pedindo o mesmo slug sem lock. `timingSafeEqual` evita ataque de temporização na comparação do hash.

### 8.3 Publicação (o coração do projeto)

```ts
// apps/web/src/lib/publisher.ts
import { Room, RoomEvent, Track, VideoPresets } from 'livekit-client';
import { PRESET_1080P60 } from '@tela/shared';

export async function startBroadcast(wsUrl: string, token: string) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width:     { ideal: 1920, max: 1920 },
      height:    { ideal: 1080, max: 1080 },
      frameRate: { ideal: 60,   max: 60 },
    },
    audio: false,               // áudio entra por trilha separada (§10)
    // @ts-expect-error — não padronizado, mas suportado em Chromium
    surfaceSwitching: 'include',
    selfBrowserSurface: 'exclude',
    systemAudio: 'include',
  });

  const track = stream.getVideoTracks()[0];

  // Sem isto, o Chrome trata a captura como "detail" (texto/documento)
  // e sacrifica framerate para manter nitidez → gameplay vira slideshow.
  track.contentHint = 'motion';

  const room = new Room({
    adaptiveStream: false,      // transmissor não recebe nada
    dynacast: true,             // desliga camadas que ninguém assiste
    publishDefaults: {
      videoCodec: 'h264',
      simulcast: true,
      degradationPreference: 'maintain-framerate',
      backupCodec: false,
    },
  });

  await room.connect(wsUrl, token);

  await room.localParticipant.publishTrack(track, {
    source: Track.Source.ScreenShare,
    videoEncoding:  PRESET_1080P60.main,
    screenShareSimulcastLayers: PRESET_1080P60.layers,
    degradationPreference: 'maintain-framerate',
  });

  // O usuário parou pela UI nativa do browser
  track.addEventListener('ended', () => room.disconnect());

  return { room, track };
}
```

```ts
// packages/shared/src/encoding.ts
export const PRESET_1080P60 = {
  main: { maxBitrate: 8_000_000, maxFramerate: 60, priority: 'high' as const },
  layers: [
    { width: 1920, height: 1080, encoding: { maxBitrate: 8_000_000, maxFramerate: 60 } },
    { width: 1280, height: 720,  encoding: { maxBitrate: 3_000_000, maxFramerate: 30 } },
  ],
};

export const PRESET_720P60 = {
  main: { maxBitrate: 4_000_000, maxFramerate: 60, priority: 'high' as const },
  layers: [
    { width: 1280, height: 720, encoding: { maxBitrate: 4_000_000, maxFramerate: 60 } },
    { width: 854,  height: 480, encoding: { maxBitrate: 1_200_000, maxFramerate: 30 } },
  ],
};
```

**Só duas camadas de simulcast, não três.** Cada camada é um encoder rodando. Três encoders 1080p60 em software derrubam o FPS do jogo. Duas cobrem os dois cenários reais (fibra e móvel) com metade do custo.

### 8.4 Espectador

```ts
// apps/web/src/lib/subscriber.ts
import { Room, RoomEvent, RemoteTrack, Track } from 'livekit-client';

export async function watch(
  wsUrl: string, token: string, videoEl: HTMLVideoElement,
) {
  const room = new Room({
    adaptiveStream: true,       // troca de camada conforme a rede
    autoSubscribe: true,
  });

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
      track.attach(videoEl);
    }
    // Mata o jitter buffer adaptativo — vale 50–100ms.
    // Só Chromium; ignorado silenciosamente nos outros.
    const receiver = track.receiver as any;
    if (receiver && 'playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
    if (receiver && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
  });

  await room.connect(wsUrl, token);
  return room;
}
```

```tsx
// autoplay: sempre mudo primeiro, senão o browser bloqueia tudo
<video ref={ref} autoPlay playsInline muted={locked} />
```

### 8.5 Leitura de stats para o HUD

```ts
// apps/web/src/lib/stats.ts
export async function readStats(sender: RTCRtpSender) {
  const report = await sender.getStats();
  let out = { fps: 0, bitrate: 0, limited: 'none', rtt: 0 };
  report.forEach((s: any) => {
    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      out.fps = s.framesPerSecond ?? 0;
      out.limited = s.qualityLimitationReason ?? 'none';
    }
    if (s.type === 'candidate-pair' && s.state === 'succeeded') {
      out.rtt = Math.round((s.currentRoundTripTime ?? 0) * 1000);
    }
  });
  return out;
}
```

`qualityLimitationReason` é o campo mais útil do WebRTC: `cpu` (encoder não dá conta), `bandwidth` (rede), `none` (tudo certo). Mostre isso na UI como diagnóstico honesto: *"Reduzindo qualidade — CPU no limite"*.

---

## 9. Pipeline de mídia

### Orçamento de latência

| Etapa | Alvo | Onde otimizar |
|---|---|---|
| Captura (getDisplayMedia) | 8–16ms | Fase 3: PipeWire direto, ~4ms |
| Encode H.264 | 10–20ms (HW) / 40ms+ (SW) | Forçar hardware encode |
| Rede transmissor→SFU | 15–40ms | Servidor em SP |
| SFU (forward) | 2–5ms | — |
| Rede SFU→espectador | 15–40ms | Servidor em SP |
| Jitter buffer | 30–80ms | `playoutDelayHint = 0` |
| Decode + render | 10–20ms | — |
| **Total** | **~110–190ms** | |

### Regras não-negociáveis

1. **H.264, não VP9/AV1.** VP9 e AV1 têm compressão melhor, mas o encode em software a 1080p60 consome CPU que o jogo precisa. H.264 tem aceleração de hardware em toda GPU dos últimos 12 anos.
2. **`contentHint = 'motion'`.** O default do Chrome para screen share é `detail` — ele prefere manter nitidez e derruba o framerate. Uma linha, e ela decide se seu produto presta.
3. **`degradationPreference = 'maintain-framerate'`.** Quando a banda apertar, prefira perder resolução a perder frames. Gameplay a 30fps nítido é pior que 60fps borrado.
4. **`dynacast: true`.** Se ninguém está assistindo a camada 1080p, o LiveKit manda o transmissor parar de codificá-la. Devolve CPU pro jogo automaticamente.
5. **Nunca 3 camadas de simulcast em 1080p60.**

### Verificação de hardware encode

Não confie — verifique. No `chrome://gpu` deve constar *Video Encode: Hardware accelerated*. No Fedora com GPU AMD/Intel, ative o VAAPI:

```bash
# chrome://flags
#include-features=VaapiVideoEncoder,VaapiVideoDecoder
# ou na linha de comando:
google-chrome --enable-features=VaapiVideoEncoder,VaapiVideoDecoder \
              --ozone-platform=wayland
```

Se `qualityLimitationReason === 'cpu'` de forma persistente, o encode está em software. Nesse caso: caia pra 720p60 e priorize a Fase 3.

---

## 10. Áudio do jogo no Linux

Este é o ponto mais frágil da Fase 1 e o principal motivo de existir a Fase 3.

**O problema:** o Chrome no Linux não entrega áudio do sistema via `getDisplayMedia`. Só áudio de aba. Jogo nativo → sem som pros espectadores.

**Solução (Fedora/PipeWire):**

```bash
#!/usr/bin/env bash
# infra/scripts/audio-linux.sh
set -euo pipefail

# 1. Cria um sink virtual que o browser enxerga como dispositivo de entrada
pactl load-module module-null-sink \
  sink_name=tela_cap \
  sink_properties=device.description=TelaCapture

# 2. Espelha o áudio pro seu fone também (senão você fica surdo)
pactl load-module module-loopback \
  source=tela_cap.monitor \
  sink="$(pactl get-default-sink)" \
  latency_msec=1

echo "Pronto. Abra o pavucontrol → aba 'Reprodução' →"
echo "mande o processo do jogo para 'TelaCapture'."
```

No front, capture o monitor **com todo o processamento desligado** — o WebRTC assume que áudio é voz e destrói música e efeitos:

```ts
// apps/web/src/lib/audio-linux.ts
export async function captureGameAudio(deviceId: string) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,     // cancelaria a trilha do jogo
      noiseSuppression: false,     // trataria efeitos sonoros como ruído
      autoGainControl: false,      // achataria a dinâmica
      channelCount: 2,
      sampleRate: 48000,
    },
  });
}

await room.localParticipant.publishTrack(audioTrack, {
  source: Track.Source.ScreenShareAudio,
  audioPreset: { maxBitrate: 128_000 },
  dtx: false,     // DTX corta "silêncio" — em jogo isso vira gaguejo
  red: false,     // redundância adiciona latência
  stopMicTrackOnMute: false,
});
```

**Matriz de suporte por plataforma (Fase 1, browser):**

| Plataforma | Áudio do sistema | Nota |
|---|---|---|
| Windows + Chrome | ✅ Nativo | Selecionar "Tela inteira" + marcar compartilhar áudio |
| Linux + Chrome | ⚠️ Via sink virtual | Script acima; UX ruim |
| macOS + Chrome | ❌ | Requer driver (BlackHole/Loopback) |
| Firefox (qualquer) | ❌ | Sem suporte a `systemAudio` |

Na Fase 3 (Tauri), tudo isso vira captura nativa e a matriz fica ✅ em toda linha.

---

## 11. UI/UX

### Princípio

Cada elemento na tela precisa justificar por que não é o vídeo. Na dúvida, remova.

### Tokens de design

```css
/* apps/web/src/styles/globals.css — Tailwind v4 */
@import "tailwindcss";

@theme {
  --color-void:    #08080A;   /* fundo absoluto */
  --color-surface: #121216;   /* HUD, cards */
  --color-line:    #232329;   /* bordas de 1px */
  --color-muted:   #6B6B76;   /* labels, metadados */
  --color-text:    #EDEDF0;
  --color-accent:  #22E07A;   /* verde ácido — só para AO VIVO e CTA */
  --color-danger:  #FF4D4D;

  --font-display: "Geist", "Inter Tight", system-ui, sans-serif;
  --font-mono:    "Geist Mono", ui-monospace, monospace;

  --radius-sm: 4px;
  --radius-md: 8px;           /* nada mais arredondado que isso */
}
```

**Regras visuais:**
- Fundo quase preto puro. O jogo é a fonte de luz da tela.
- Um único acento saturado, usado exclusivamente para "AO VIVO" e o botão primário.
- Tipografia condensada. Números em monoespaçada (bitrate, latência, viewers) para não dançarem ao atualizar.
- Zero sombras, zero gradientes, zero cards com borda arredondada de dashboard.
- Referência de tom: Parsec e Kick. **Anti-referência: Zoom, Teams, Meet.**

### Tela 1 — Home (transmissor, nunca transmitiu)

```
┌────────────────────────────────────────────────┐
│                                                │
│                                                │
│                                                │
│              ┌──────────────────┐              │
│              │   ▶  TRANSMITIR  │              │
│              └──────────────────┘              │
│                                                │
│           seu link:  tela.gg/[ jv    ]         │
│                                                │
│                                                │
└────────────────────────────────────────────────┘
```

Um botão. Um campo. Nada mais — nem header, nem logo, nem rodapé, nem "como funciona". Validação do slug em tempo real (debounce 300ms) com um ponto verde/vermelho ao lado do campo.

### Tela 2 — Transmitindo (HUD)

```
┌────────────────────────────────────────────────┐
│  ● AO VIVO   tela.gg/jv  [copiar]   👁 4       │
│  1080p60 · 7.4 Mbps · 142ms          [ parar ] │
└────────────────────────────────────────────────┘
        ↑ some após 5s, volta no mousemove
```

- Fica no canto superior. Nunca cobre o centro.
- O link já foi copiado — o botão "copiar" existe pra segunda vez.
- Se `qualityLimitationReason` mudar, o badge vira amarelo com o motivo real: *"CPU no limite — reduzindo para 720p"*.
- Aviso persistente e discreto: **fechar esta aba encerra a transmissão**.

### Tela 3 — Espectador (a que decide o produto)

```
┌────────────────────────────────────────────────┐
│                                                │
│                                                │
│              [ gameplay 100% ]                 │
│                                                │
│                                                │
│  ● AO VIVO                          142ms  ⛶  │
└────────────────────────────────────────────────┘
     ↑ controles somem em 2s
```

- Vídeo em 100% da viewport desde o primeiro frame. Sem header, sem sidebar, sem logo.
- **Overlay de áudio:** autoplay com som é bloqueado por política do browser. Isso não é bug, é design: overlay grande e claro — *"Clique para ativar o som"* — que desaparece no primeiro clique em qualquer lugar da tela.
- Latência em ms visível no canto. É prova social da qualidade e o público-alvo repara.
- Atalhos: duplo clique = fullscreen, `Espaço` = mudo, `F` = fullscreen. Só isso.

### Tela 4 — Offline

```
┌────────────────────────────────────────────────┐
│                                                │
│              jv não está transmitindo          │
│                                                │
│              ● aguardando...                   │
│                                                │
└────────────────────────────────────────────────┘
```

Polling a cada 5s com backoff até 30s. Quando entrar ao vivo, conecta sozinho — o amigo deixa a aba aberta e o jogo aparece.

### Microdetalhes que fazem diferença

| Detalhe | Por quê |
|---|---|
| Copiar link automaticamente ao iniciar | Remove um passo do fluxo principal |
| Título da aba muda para `● tela.gg/jv` ao vivo | Achar a aba entre 30 outras |
| `sendBeacon` no `beforeunload` | Sala fecha na hora, sem esperar timeout |
| Wake Lock API durante transmissão | Impede a tela de apagar |
| Botão "parar" pede confirmação só se houver espectadores | Não atrapalha quando está sozinho |
| Números em fonte monoespaçada | Evita layout shift a cada atualização |

---

## 12. Self-hosting

### 12.1 Escolha do servidor — a decisão mais importante

Latência é geografia. Servidor fora do Brasil inviabiliza o produto.

| Provedor | Região | Custo | Egress | Veredito |
|---|---|---|---|---|
| **Oracle Cloud** | São Paulo | Free tier: 4 vCPU ARM, 24GB | **10 TB/mês grátis** | Melhor opção disponível |
| **Vultr** | São Paulo | ~$24/mês (4 vCPU, 8GB) | 4 TB | Ótimo, simples |
| **DigitalOcean** | — | — | — | Sem região no Brasil |
| **Magalu Cloud / Locaweb** | Brasil | Variável | Variável | Ler o contrato de tráfego |
| **AWS sa-east-1** | São Paulo | + ~$0,15/GB egress | — | **Não use** — 1,5TB = ~$225/mês |

**Critério de escolha: egress, não CPU.** O SFU só encaminha pacotes — 10 espectadores ocupam menos de 15% de 2 vCPUs. O que quebra o orçamento é banda.

Latência de referência a partir de Fortaleza: São Paulo ~35–45ms, Miami ~120ms, Frankfurt ~200ms.

### 12.2 DNS

```
A     tela.gg        →  <IP público>
A     www.tela.gg    →  <IP público>
A     turn.tela.gg   →  <IP público>
```

`turn.tela.gg` precisa apontar para o mesmo IP — o TURN embutido do LiveKit usa esse hostname no certificado TLS.

### 12.3 docker-compose.yml

```yaml
# infra/compose/docker-compose.yml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    network_mode: host          # precisa ver o LiveKit em host network
    volumes:
      - ../caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ../../apps/web/dist:/srv/web:ro
      - caddy_data:/data
      - caddy_config:/config

  livekit:
    image: livekit/livekit-server:v1.8
    restart: unless-stopped
    network_mode: host          # OBRIGATÓRIO — ver §12.6
    command: --config /etc/livekit.yaml
    volumes:
      - ../livekit/livekit.yaml:/etc/livekit.yaml:ro
    depends_on: [redis]

  api:
    build:
      context: ../..
      dockerfile: apps/api/Dockerfile
    restart: unless-stopped
    network_mode: host
    env_file: ../.env
    depends_on: [redis, livekit]

  redis:
    image: redis:8-alpine
    restart: unless-stopped
    command: >
      redis-server
      --save 900 1
      --appendonly no
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
    ports: ["127.0.0.1:6379:6379"]   # nunca exponha o Redis
    volumes: [redis_data:/data]

volumes:
  caddy_data:
  caddy_config:
  redis_data:
```

### 12.4 livekit.yaml

```yaml
# infra/livekit/livekit.yaml
port: 7880
bind_addresses:
  - "0.0.0.0"

rtc:
  tcp_port: 7881
  udp_port: 7882              # porta única multiplexada — muito mais simples
  use_external_ip: true       # descobre o IP público via STUN
  enable_loopback_candidate: false
  congestion_control:
    enabled: true
    allow_pause: false        # não congele o vídeo em queda de banda

redis:
  address: 127.0.0.1:6379

keys:
  APIxxxxxxxxxxxx: <SEGREDO_GERADO_COM_openssl_rand_base64_36>

turn:
  enabled: true
  domain: turn.tela.gg
  udp_port: 3478
  tls_port: 5349
  # o LiveKit obtém o certificado via Let's Encrypt sozinho
  # se preferir usar o do Caddy:
  # cert_file: /certs/fullchain.pem
  # key_file:  /certs/privkey.pem

room:
  auto_create: false          # só a API cria salas — evita spam
  empty_timeout: 120
  departure_timeout: 20
  max_participants: 13

webhook:
  api_key: APIxxxxxxxxxxxx
  urls:
    - http://127.0.0.1:3333/api/livekit/webhook

logging:
  level: info
  json: false

prometheus_port: 6789         # métricas, exposto só na loopback
```

### 12.5 Caddyfile

```
# infra/caddy/Caddyfile
tela.gg, www.tela.gg {
    encode zstd gzip

    # WebSocket de signaling do LiveKit
    handle /rtc* {
        uri strip_prefix /rtc
        reverse_proxy 127.0.0.1:7880
    }

    handle /api/* {
        reverse_proxy 127.0.0.1:3333
    }

    handle {
        root * /srv/web
        try_files {path} /index.html      # SPA — /:slug cai no index
        file_server
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        Permissions-Policy "display-capture=(self), microphone=(), camera=(), geolocation=()"
        -Server
    }

    log {
        output file /var/log/caddy/tela.log
        format json
    }
}
```

`Permissions-Policy: display-capture=(self)` é necessário — sem isso o `getDisplayMedia` é bloqueado em alguns contextos.

### 12.6 Firewall

```bash
#!/usr/bin/env bash
# infra/scripts/firewall.sh
set -euo pipefail

ufw default deny incoming
ufw default allow outgoing

ufw allow 22/tcp     comment 'ssh'
ufw allow 80/tcp     comment 'http (acme)'
ufw allow 443/tcp    comment 'https'
ufw allow 7881/tcp   comment 'livekit ice-tcp fallback'
ufw allow 7882/udp   comment 'livekit media'
ufw allow 3478/udp   comment 'turn'
ufw allow 5349/tcp   comment 'turn tls'

ufw --force enable
ufw status numbered
```

**7882/udp é o que faz o produto funcionar.** Se o UDP estiver bloqueado, tudo cai pro TCP na 7881, o TCP faz retransmissão ordenada e a latência dobra ou triplica. Valide de fora:

```bash
nc -zvu <IP> 7882
```

Em nuvem, lembre que existem **dois** firewalls: o do SO (ufw) e o do provedor (Security Group / Network Security List). O da Oracle é o esquecido com mais frequência.

### 12.7 Armadilhas do self-host

| Armadilha | Sintoma | Correção |
|---|---|---|
| LiveKit sem `network_mode: host` | Docker trava minutos no start; ICE falha | Sempre host network. Se impossível, `udp_port` única + `-p 7882:7882/udp` |
| `use_external_ip: false` atrás de NAT | Conecta no signaling, vídeo nunca aparece | `use_external_ip: true` ou fixar `node_ip` |
| Certificado do TURN faltando | Alguns usuários não conectam, outros sim | `turn.dominio` no DNS + porta 80 aberta pro ACME |
| Redis exposto em 0.0.0.0 | Comprometimento | Bind em `127.0.0.1` |
| Docker Swarm / Dokploy gerenciando o LiveKit | Rede overlay quebra o ICE | Rode o LiveKit fora do Swarm, via compose direto |
| Faltou `try_files` no Caddy | `tela.gg/jv` dá 404 | SPA fallback pro `index.html` |
| `auto_create: true` | Qualquer token cria sala | `false` + criação só pela API |

### 12.8 Bootstrap do zero

```bash
#!/usr/bin/env bash
# infra/scripts/bootstrap.sh — Ubuntu 24.04
set -euo pipefail

apt update && apt upgrade -y
apt install -y ca-certificates curl git ufw

# Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Tuning de rede para alto volume de UDP
cat >> /etc/sysctl.conf <<'EOF'
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.core.netdev_max_backlog=5000
EOF
sysctl -p

# Segredos
echo "LIVEKIT_API_SECRET=$(openssl rand -base64 36)"

bash "$(dirname "$0")/firewall.sh"

echo "Agora: preencha infra/.env, ajuste livekit.yaml e rode:"
echo "  docker compose -f infra/compose/docker-compose.yml up -d"
```

O tuning de `rmem_max`/`wmem_max` não é enfeite: o default do Linux (~200KB) causa perda de pacotes em rajada com múltiplos fluxos de vídeo.

### 12.9 Desenvolvimento local

```yaml
# infra/compose/docker-compose.dev.yml
services:
  livekit:
    image: livekit/livekit-server:v1.8
    command: --dev --bind 0.0.0.0
    network_mode: host
  redis:
    image: redis:8-alpine
    ports: ["6379:6379"]
```

```bash
docker compose -f infra/compose/docker-compose.dev.yml up -d
pnpm dev   # turbo roda api (3333) e web (5173)
```

No modo `--dev` o LiveKit usa a chave fixa `devkey` / `secret`. **Nunca em produção.**

---

## 13. Runbook operacional

### Diagnóstico rápido

```bash
# Todos de pé?
docker compose ps

# LiveKit respondendo?
curl -s localhost:7880 && echo OK

# API viva?
curl -s localhost:3333/api/health | jq

# Métricas do SFU
curl -s localhost:6789/metrics | grep livekit_

# Salas ativas
docker compose exec livekit livekit-cli list-rooms \
  --url http://localhost:7880 --api-key "$KEY" --api-secret "$SECRET"

# Estado no Redis
docker compose exec redis redis-cli --scan --pattern 'live:*'
```

### Árvore de decisão — "não conecta"

```
Espectador vê tela preta eterna
│
├─ Console mostra erro de WebSocket?
│   └─ Signaling. Cheque Caddy /rtc e o LiveKit na 7880.
│
├─ Conecta mas nenhum frame chega?
│   └─ ICE. Abra chrome://webrtc-internals:
│       ├─ Nenhum candidate "srflx"  → use_external_ip / STUN
│       ├─ Só candidates "relay"     → UDP bloqueado; funciona mas lento
│       └─ Nenhum candidate          → firewall 7882/udp fechado
│
└─ Vídeo aparece e trava depois de segundos?
    └─ Banda. Veja qualityLimitationReason no transmissor.
```

### Árvore de decisão — "está ruim"

| Sintoma | Causa provável | Verificação | Correção |
|---|---|---|---|
| Vídeo travado/slideshow | `contentHint` errado | `track.contentHint` | `= 'motion'` |
| FPS do jogo despencou | Encode em software | `chrome://gpu` | Ativar VAAPI, ou 720p, ou Fase 3 |
| Latência >500ms | Servidor longe ou TCP | `webrtc-internals` → RTT | Servidor em SP; liberar UDP |
| Áudio gaguejando | DTX ligado | Config de publish | `dtx: false` |
| Áudio metálico | Processamento de voz | Constraints | Desligar AEC/NS/AGC |
| Qualidade cai só pra um viewer | Funcionando como esperado | — | É o simulcast agindo |
| Todos caem juntos | Simulcast desligado | `simulcast: true`? | Ativar |

### Backup

Não há o que fazer backup do vídeo (nada é gravado). O único estado durável é `slug:*` no Redis:

```bash
# diário via cron
docker compose exec redis redis-cli --rdb /data/dump.rdb
tar czf "/backup/tela-$(date +%F).tgz" \
  /var/lib/docker/volumes/compose_redis_data/_data/dump.rdb
```

Perder isso significa: todos os slugs ficam livres novamente. Chato, não catastrófico.

### Atualização

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
docker compose -f infra/compose/docker-compose.yml up -d --build api
# LiveKit: derruba as salas ativas — avise antes
docker compose pull livekit && docker compose up -d livekit
```

---

## 14. Custos

### Conta de banda

```
Bitrate por espectador (camada alta):        8 Mbps
Espectadores simultâneos típicos:            5
Egress sustentado:                          40 Mbps
Horas por dia:                               3
Dias por mês:                               30

40 Mbps × 3h × 3600s × 30d ÷ 8 = 1.620 GB/mês ≈ 1,6 TB
```

Com simulcast e Dynacast, o valor real cai (nem todo espectador puxa a camada alta). Orce **2 TB/mês** com folga.

### Cenários

| Cenário | Egress/mês | Oracle Free | Vultr SP | AWS sa-east-1 |
|---|---|---|---|---|
| Só você, 5 amigos, 3h/dia | ~1,6 TB | **R$ 0** | ~R$ 130 | ~R$ 1.300 |
| 5 transmissores ativos | ~8 TB | **R$ 0** | ~R$ 250 | ~R$ 6.500 |
| 20 transmissores ativos | ~32 TB | excede | ~R$ 900 | inviável |

O free tier da Oracle em São Paulo cobre confortavelmente o caso de uso original — grupo de amigos. Custo total do projeto: **domínio (~R$ 40/ano) e nada mais.**

### Quando o custo vira problema

Acima de ~30 transmissores simultâneos, a arquitetura precisa mudar: SFU regional com múltiplos nós, ou saída em LL-HLS via CDN para audiências grandes (aceitando 2–5s de latência). Isso é outro produto — não otimize pra ele agora.

---

## 15. Segurança e LGPD

### Superfície de ataque e mitigações

| Vetor | Mitigação |
|---|---|
| Roubo de slug | `ownerToken` de 256 bits, comparação em tempo constante |
| Enumeração de slugs | `GET /live/:slug` não distingue "não existe" de "offline" |
| Squatting em massa | 5 claims/hora por IP + blocklist |
| Espectador virando publisher | `canPublish: false` no grant, aplicado pelo SFU |
| Sala criada por token forjado | `auto_create: false`; só a API cria |
| Webhook forjado | `WebhookReceiver` valida assinatura HMAC |
| Redis exposto | Bind em loopback |
| Vazamento de segredo | Segredos só em `.env` no servidor, nunca no bundle do front |
| Amplificação via TURN | `max_participants` limitado; TURN só para salas conhecidas |

### Dados pessoais tratados

Este é o ponto forte da arquitetura, e vale explicitar no README:

| Dado | Coletado? |
|---|---|
| Nome, e-mail, telefone | Não |
| Senha | Não |
| Cookie de rastreamento | Não |
| Analytics de terceiros | Não |
| Gravação de vídeo/áudio | Não |
| IP | Sim — logs do Caddy, retenção 7 dias |
| Slug + hash do ownerToken | Sim — expira em 180 dias de inatividade |

Sem cadastro não significa sem LGPD (IP é dado pessoal), mas o volume de tratamento é mínimo. Retenção curta de log e ausência de gravação são as duas decisões que sustentam isso.

### Sobre o contexto regulatório

Vale entender o que aconteceu antes de decidir como distribuir isso. A medida da ANPD contra o Discord foi preventiva e cirúrgica: atingiu a funcionalidade de transmissão ao vivo por ser onde a agência identificou risco a menores de 18 anos, dentro de uma fiscalização sob o ECA Digital — e não a tecnologia de vídeo em si. Meet, Jitsi, Twitch e Zoom seguem operando normalmente no Brasil.

O que muda conforme o modelo de distribuição:

**Self-hosted, círculo fechado** (o escopo deste documento): você roda no seu servidor, o link só existe se você mandou. Não há descoberta pública, diretório, nem pareamento com estranhos. É equivalente a rodar um Jitsi próprio — sem obrigação regulatória adicional.

**Serviço público aberto**, onde qualquer pessoa transmite para qualquer pessoa: aí o cenário é exatamente o que motivou a medida, e três coisas deixam de ser opcionais:
- Verificação de idade no fluxo de transmissão
- Botão de denúncia com capacidade real de encerrar transmissão
- Registro mínimo para atender autoridade (quem transmitiu, quando, para quantos — sem gravar conteúdo)

A arquitetura já ajuda no primeiro caso: link não indexável, sem diretório, sem busca. Se um dia virar serviço aberto, esses três itens são um sprint — desde que você não tenha construído o resto assumindo que nunca precisaria deles.

---

## 16. Roadmap

### Fase 0 — Spike (1 fim de semana) — *bloqueante*

- [ ] Subir LiveKit em Docker no servidor de SP
- [ ] Publicar 1080p60 de uma aba pelo `livekit-cli` ou pelo playground
- [ ] **Medir latência glass-to-glass com câmera** (§18)
- [ ] Validar 7882/udp aberto de fora
- [ ] Confirmar hardware encode em `chrome://gpu`

**Portão:** se latência >350ms ou encode em software, resolva antes de prosseguir.

### Fase 1 — MVP (2–3 semanas)

- [ ] Monorepo + shared schemas
- [ ] API: claim, start, ping, stop, live, join, webhook
- [ ] Front: Home, Broadcast, Viewer
- [ ] Publisher com preset 1080p60 + simulcast 2 camadas
- [ ] Subscriber com `playoutDelayHint = 0`
- [ ] Caddy + TLS + SPA fallback
- [ ] Deploy

**Portão:** 5 amigos assistindo simultaneamente, 30 minutos sem queda.

### Fase 2 — Qualidade e UX (2 semanas)

- [ ] HUD com stats reais e diagnóstico honesto
- [ ] Áudio do sistema (Windows nativo, Linux via script)
- [ ] Adaptação de qualidade visível ao usuário
- [ ] Estado offline com auto-conexão
- [ ] Wake Lock, título de aba dinâmico, `sendBeacon`
- [ ] Atalhos de teclado, fullscreen
- [ ] Página de recuperação de slug (mostrar/exportar ownerToken)

**Portão:** um amigo não-técnico consegue assistir sem instrução.

### Fase 3 — App nativo (4+ semanas)

- [ ] Tauri 2 com captura por plataforma
- [ ] Encode por hardware (NVENC / VAAPI / QuickSync)
- [ ] Áudio do sistema nativo em todas as plataformas
- [ ] Ícone na bandeja, atalho global, sem depender de aba aberta
- [ ] Auto-update

### Explicitamente adiado (talvez para sempre)

- Múltiplos transmissores na mesma sala
- Gravação e clipes
- Chat, emotes, reações
- Mobile como transmissor (viewer mobile funciona desde a Fase 1)

---

## 17. Fase 3 — App nativo (Tauri)

### Por que existe

| | Browser (Fase 1) | Tauri (Fase 3) |
|---|---|---|
| Latência de captura | 8–16ms | 3–6ms |
| Encode | Depende de flag do browser | NVENC/VAAPI direto |
| Áudio do sistema no Linux | Sink virtual manual | Nativo (PipeWire) |
| Áudio do sistema no macOS | Impossível sem driver | Nativo (ScreenCaptureKit) |
| Aba precisa ficar aberta | Sim | Não |
| RAM | ~250MB (aba Chrome) | ~40MB |
| Captura de janela específica | Picker do sistema toda vez | Lembra a escolha |

### Captura por plataforma

| SO | API | Crate |
|---|---|---|
| Linux | PipeWire + xdg-desktop-portal | `pipewire-rs`, `ashpd` |
| Windows | Windows.Graphics.Capture (DXGI) | `windows-capture` |
| macOS | ScreenCaptureKit | `screencapturekit-rs` |

### Encode por hardware

| GPU | Encoder | Latência típica |
|---|---|---|
| NVIDIA | NVENC (`nvidia-video-codec`) | 5–10ms |
| AMD/Intel Linux | VAAPI | 8–15ms |
| Intel Windows | QuickSync | 8–15ms |
| Apple Silicon | VideoToolbox | 5–10ms |
| Fallback | x264 `ultrafast` `zerolatency` | 30–50ms |

Config NVENC para baixa latência:
```
preset:      P1 (fastest) ou P4 (low-latency HQ)
tuning:      ultra-low-latency
rc:          CBR
lookahead:   off        # lookahead adiciona latência de frames
bframes:     0          # B-frames adicionam latência de reordenação
gop:         120        # keyframe a cada 2s
```

`bframes: 0` e `lookahead: off` são obrigatórios — são as duas configurações que mais adicionam latência e as que mais aparecem ligadas por default.

### WebRTC em Rust

Duas opções: `webrtc-rs` (puro Rust, mais leve, menos maduro) ou binding pra `libwebrtc` (maduro, build pesado). Alternativa que economiza semanas: publicar via **WHIP** (`HTTP POST` com SDP) — o LiveKit tem endpoint WHIP nativo, e você só precisa de ICE + DTLS-SRTP, não da stack WebRTC inteira.

---

## 18. Testes e benchmark

### Latência glass-to-glass — o único método confiável

`RTCStats` mede rede, não a experiência. O que importa é do pixel na sua tela ao pixel na tela do amigo.

```
1. Abra um cronômetro em milissegundos (ex: uma página com performance.now())
2. Transmita a tela do cronômetro
3. Ponha os dois monitores lado a lado (transmissor e espectador)
4. Filme os dois com um celular a 240fps
5. Avance quadro a quadro e subtraia os valores lidos
6. Repita 10 vezes, use a mediana
```

Resultado esperado: 110–190ms na mesma cidade, 150–250ms Fortaleza↔SP.

### Impacto no jogo

```bash
# 1. Rode o jogo com MangoHud, 10 min, sem transmitir
MANGOHUD_CONFIG=fps,frametime,gpu_load,cpu_load mangohud %command%
# 2. Repita transmitindo
# 3. Compare o p1% low, não a média — o que incomoda são os stutters
```

Aceite: perda <5% no p1% low.

### Teste de rede degradada

```bash
# simula 4G ruim no espectador
sudo tc qdisc add dev eth0 root netem \
  delay 80ms 20ms loss 2% rate 4mbit

# limpar
sudo tc qdisc del dev eth0 root
```

Aceite: o espectador degradado cai pra 720p30 e **os outros não são afetados**. Se todos caírem juntos, o simulcast não está funcionando.

### Teste de carga

```bash
livekit-cli load-test \
  --url ws://localhost:7880 \
  --api-key "$KEY" --api-secret "$SECRET" \
  --room b_teste \
  --subscribers 12 --duration 10m
```

Monitore `livekit_participant_*` e a CPU. Com 12 espectadores, esperado <20% de 2 vCPUs.

### CI

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo lint typecheck test build
```

---

## Apêndice — Registro de decisões (ADR resumido)

| # | Decisão | Alternativa rejeitada | Motivo |
|---|---|---|---|
| 1 | LiveKit como SFU | mediasoup, MediaMTX | Simulcast server-side; ~3 semanas de economia |
| 2 | Sem chat nem voz | Reimplementar o Discord | O Discord segue funcionando para texto e voz no Brasil |
| 3 | Slug permanente via localStorage | Link efêmero por sessão | Amigo salva uma vez; melhor UX que qualquer login |
| 4 | H.264 | VP9, AV1 | Único com hardware encode universal |
| 5 | 2 camadas de simulcast | 3 camadas | Cada camada é um encoder disputando CPU com o jogo |
| 6 | Redis, sem Postgres | Postgres desde o início | Todo o estado do v1 é efêmero |
| 7 | TURN embutido no LiveKit | coturn separado | Um serviço e uma config de IP a menos |
| 8 | Oracle Cloud SP | AWS sa-east-1 | 10 TB de egress grátis vs ~R$ 1.300/mês |
| 9 | Tauri na Fase 3 | Electron | RAM e CPU importam num app que roda junto com jogo |
| 10 | Sem gravação | VOD/clipes | Elimina armazenamento, custo e a maior parte da exposição LGPD |

---

*Documento vivo. Ao mudar uma decisão, registre no apêndice com o motivo — daqui a seis meses você não vai lembrar por que escolheu H.264.*
