# Tela — Changeset 001: Arquitetura P2P Mesh

> **Para o agente de desenvolvimento.** Este documento altera decisões de
> `TELA-documentacao-tecnica.md` e `AGENTS.md`. Onde houver conflito,
> **este changeset vence**.
>
> Leia inteiro antes de escrever ou apagar qualquer coisa.

---

## 1. O que mudou e por quê

### ADR-0005 — Mesh P2P como transporte primário

**Contexto**

Duas restrições novas surgiram depois de os documentos originais serem escritos:

1. Orçamento zero. Não há servidor a pagar nem a administrar.
2. O projeto também é peça de portfólio.

O SFU (LiveKit) resolvia o problema de escala — dezenas de espectadores por transmissor. Esse problema não existe aqui: a sessão real é uma pessoa jogando e 2 a 3 amigos assistindo.

**Decisão**

Transporte primário passa a ser **mesh P2P**: cada espectador recebe uma `RTCPeerConnection` direta do transmissor. Nenhum vídeo passa por servidor.

`MediaTransport` continua sendo a interface. LiveKit não é removido do desenho — vira um adapter alternativo documentado, não implementado.

**Consequências**

| | |
|---|---|
| + | Custo de infraestrutura: zero, permanente |
| + | Latência menor — sem hop de servidor (~30–50ms a menos) |
| + | Sem VM para administrar, sem Docker, sem firewall |
| + | Portfólio mais forte: WebRTC de baixo nível em vez de config de SFU |
| + | Escopo cai de 6 milestones para 4 |
| − | Teto de 3 espectadores simultâneos |
| − | Upload do transmissor multiplica por espectador |
| − | Sem simulcast — adaptação vira responsabilidade nossa |
| − | ~15–20% das conexões dependem de TURN de terceiro com cota |

**Status:** Aceita — 2026-08-23

---

## 2. Se você já implementou algo

Mapa do que aproveitar. **Não apague nada antes de ler esta tabela.**

| Já feito | Ação |
|---|---|
| M0 — monorepo, tsconfig, eslint boundaries, CI | **Mantenha integralmente** |
| `packages/shared` — schemas, presets, blocklist | Mantenha; ajustes na §5 |
| `domain/slug.ts`, `domain/result.ts`, `domain/errors.ts` | **Mantenha** — migram para o web |
| `domain/room.ts` | Mantenha, renomeie conceito para "canal" |
| `application/` da API | **Descarte** — não há mais casos de uso de servidor |
| `infra/redis/`, `infra/livekit/` | **Descarte** |
| `http/` da API | **Descarte** |
| `apps/api` inteiro | **Descarte** — vira `apps/signaling` (§4) |
| `infra/compose`, `livekit.yaml`, `Caddyfile`, scripts | **Descarte** |
| `core/media/broadcast-session.ts` | **Mantenha** — só troca o transport injetado |
| `core/media/viewer-session.ts` | **Mantenha** |
| `core/media/stats-sampler.ts` | Mantenha; ajuste para agregar N senders |
| `core/ports/media-transport.ts` | Mantenha; extensões na §6 |
| `adapters/livekit-transport.ts` | Mova para `adapters/_reference/` como documentação |
| `components/`, `routes/` | Mantenha; ajustes de UI na §8 |

Se `BroadcastSession` precisar de mudanças além da injeção do transport, isso é sinal de que a regra R1/R2 foi violada em algum ponto — reporte antes de corrigir.

Faça a limpeza em um commit isolado: `refactor: remover camada de servidor de mídia (changeset 001)`.

---

## 3. Arquitetura nova

```
┌──────────────────────────────────────────────────────┐
│  Cloudflare Pages / GitHub Pages   (estático, grátis)│
│  React + core/ + adapters/mesh                       │
└───────────────┬──────────────────────────────────────┘
                │ WebSocket (só SDP e ICE — nunca mídia)
                ▼
┌──────────────────────────────────────────────────────┐
│  Signaling  — ~200 linhas, free tier                 │
│  canais por slug, relay de mensagens, presença       │
└──────────────────────────────────────────────────────┘

        STUN público (grátis)  ·  TURN free tier (cota)

  Transmissor ──┬──► Espectador 1     RTCPeerConnection direta
                ├──► Espectador 2     mídia NUNCA toca servidor
                └──► Espectador 3
```

**Invariante:** o servidor de signaling nunca vê um byte de mídia. Se ele cair durante uma transmissão, as conexões já estabelecidas continuam funcionando — só novos espectadores não entram. Documente isso no README; é um bom detalhe de arquitetura.

---

## 4. Estrutura de repositório

```
tela/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── core/
│   │   │   │   ├── media/
│   │   │   │   │   ├── broadcast-session.ts    [mantido]
│   │   │   │   │   ├── viewer-session.ts       [mantido]
│   │   │   │   │   ├── stats-sampler.ts        [ajustado]
│   │   │   │   │   ├── presets.ts              [ajustado]
│   │   │   │   │   └── bandwidth-probe.ts      [NOVO]
│   │   │   │   ├── mesh/                       [NOVO]
│   │   │   │   │   ├── peer-link.ts            perfect negotiation
│   │   │   │   │   ├── mesh-topology.ts        gerencia N peers
│   │   │   │   │   └── ice-config.ts           STUN/TURN
│   │   │   │   ├── ports/
│   │   │   │   │   ├── media-transport.ts      [estendido]
│   │   │   │   │   ├── signaling-channel.ts    [NOVO]
│   │   │   │   │   ├── screen-capture.ts       [mantido]
│   │   │   │   │   └── audio-capture.ts        [mantido]
│   │   │   │   ├── domain/                     [NOVO — migrado da API]
│   │   │   │   │   ├── result.ts
│   │   │   │   │   ├── errors.ts
│   │   │   │   │   ├── slug.ts
│   │   │   │   │   └── channel.ts
│   │   │   │   └── identity/owner-token.ts     [mantido]
│   │   │   ├── adapters/
│   │   │   │   ├── mesh-transport.ts           [NOVO — implementa MediaTransport]
│   │   │   │   ├── ws-signaling.ts             [NOVO — implementa SignalingChannel]
│   │   │   │   ├── browser-screen-capture.ts   [mantido]
│   │   │   │   ├── browser-audio-capture.ts    [mantido]
│   │   │   │   └── _reference/
│   │   │   │       └── livekit-transport.ts    [referência, não usado]
│   │   │   ├── react/  components/  routes/  styles/
│   │
│   └── signaling/                              [NOVO — substitui apps/api]
│       ├── src/
│       │   ├── server.ts
│       │   ├── channel-registry.ts
│       │   ├── protocol.ts                     mensagens tipadas
│       │   └── limits.ts                       rate limit, MAX_PEERS
│       └── package.json
│
├── packages/shared/                            [mantido, §5]
└── docs/
    └── adr/0005-mesh-p2p.md                    [criar com a §1]
```

`apps/api` deixa de existir. `infra/` deixa de existir.

---

## 5. Protocolo de signaling

Contrato em `packages/shared/src/signaling.ts`, usado pelos dois lados.

```ts
import { z } from 'zod';

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('host'),   slug: z.string(), ownerToken: z.string() }),
  z.object({ type: z.literal('watch'),  slug: z.string() }),
  z.object({ type: z.literal('signal'), to: z.string(), payload: z.unknown() }),
  z.object({ type: z.literal('leave') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hosting'), peerId: z.string() }),
  z.object({ type: z.literal('watching'), peerId: z.string(), hostId: z.string() }),
  z.object({ type: z.literal('peer-joined'), peerId: z.string() }),
  z.object({ type: z.literal('peer-left'),   peerId: z.string() }),
  z.object({ type: z.literal('signal'), from: z.string(), payload: z.unknown() }),
  z.object({ type: z.literal('error'), code: SignalingErrorCode }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const SignalingErrorCode = z.enum([
  'SLUG_TAKEN',      // já existe transmissão nesse slug
  'SLUG_INVALID',
  'NOT_HOSTING',     // ninguém transmitindo nesse slug
  'CHANNEL_FULL',    // MAX_PEERS atingido
  'RATE_LIMITED',
  'OWNER_INVALID',
]);
```

**Regras do servidor de signaling:**

- Não persiste nada. Um `Map` em memória. Reiniciou, esvaziou — aceitável.
- Nunca inspeciona nem valida o conteúdo de `payload`. Ele é opaco: SDP e ICE passam sem serem lidos.
- `MAX_PEERS = 3` por canal, configurável por env.
- Rate limit: 30 mensagens por 10s por conexão; 5 tentativas de `host` por minuto por IP.
- Mensagem acima de 64 KB → derruba a conexão.
- `ownerToken` só é comparado, nunca logado.
- Ping/pong a cada 30s; conexão morta é limpa junto com o canal.

**Onde hospedar:** o serviço é um WebSocket relay portátil e sem estado durável. Escreva com Hono ou `ws` puro, sem depender de API específica de plataforma, e mantenha `SignalingChannel` como port no cliente. Assim ele roda em qualquer free tier de WebSocket disponível — e se nenhum servir, existe a opção de usar um broker gerenciado de free tier no lugar, trocando só o adapter.

Verifique os limites atuais do free tier escolhido antes de fixar a plataforma e registre a escolha num ADR.

---

## 6. `MediaTransport` estendido

A interface ganha o conceito de múltiplos peers.

```ts
// core/ports/media-transport.ts
export interface PeerInfo {
  id: string;
  connectionState: RTCPeerConnectionState;
  usingRelay: boolean;        // true = passando por TURN
  outboundBitrate: number;
}

export interface MediaTransport {
  host(slug: string, ownerToken: string): Promise<void>;
  watch(slug: string): Promise<void>;

  publishVideo(track: MediaStreamTrack, opts: PublishOptions): Promise<void>;
  publishAudio(track: MediaStreamTrack): Promise<void>;

  disconnect(): Promise<void>;

  onPeersChange(cb: (peers: PeerInfo[]) => void): () => void;
  onRemoteTrack(cb: (track: MediaStreamTrack) => void): () => void;
  onConnectionStateChange(cb: (s: ConnectionState) => void): () => void;

  getAggregateStats(): Promise<MediaStats | null>;
}
```

`getSenderStats` vira `getAggregateStats` — em mesh há N senders, e o HUD mostra o total de upload e o pior RTT.

`usingRelay` existe para a UI avisar honestamente quando um espectador está passando por TURN (latência maior, cota consumida).

---

## 7. Implementação do mesh

### 7.1 Perfect negotiation

Use o padrão canônico do W3C. O transmissor é **impolite**, os espectadores são **polite**.

```ts
// core/mesh/peer-link.ts
export class PeerLink {
  #pc: RTCPeerConnection;
  #makingOffer = false;
  #ignoreOffer = false;

  constructor(
    private readonly peerId: string,
    private readonly polite: boolean,
    private readonly send: (payload: unknown) => void,
    iceServers: RTCIceServer[],
  ) {
    this.#pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 4,
    });

    this.#pc.onnegotiationneeded = async () => {
      try {
        this.#makingOffer = true;
        await this.#pc.setLocalDescription();
        this.send({ description: this.#pc.localDescription });
      } finally {
        this.#makingOffer = false;
      }
    };

    this.#pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ candidate });
    };
  }

  async handleSignal(payload: { description?: RTCSessionDescriptionInit;
                                candidate?: RTCIceCandidateInit }) {
    const { description, candidate } = payload;

    if (description) {
      const offerCollision =
        description.type === 'offer' &&
        (this.#makingOffer || this.#pc.signalingState !== 'stable');

      this.#ignoreOffer = !this.polite && offerCollision;
      if (this.#ignoreOffer) return;

      await this.#pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await this.#pc.setLocalDescription();
        this.send({ description: this.#pc.localDescription });
      }
      return;
    }

    if (candidate) {
      try { await this.#pc.addIceCandidate(candidate); }
      catch (e) { if (!this.#ignoreOffer) throw e; }
    }
  }
}
```

Não invente um handshake próprio. Este padrão existe porque colisão de oferta acontece de verdade quando o transmissor adiciona a trilha de áudio depois do vídeo.

### 7.2 A regra que protege o FPS do jogo

**Todos os peers recebem parâmetros de encoding idênticos.** O Chrome reaproveita o mesmo encoder entre `RTCRtpSender`s com parâmetros iguais — um encode, três envios. Se você variar bitrate por peer, viram três encoders e o FPS do jogo despenca.

Portanto: **adaptação é coletiva, não individual.** Se um espectador tem rede ruim, ou ele aguenta o que está sendo enviado, ou todos descem juntos um degrau.

```ts
// core/mesh/mesh-topology.ts
/**
 * Adaptação coletiva. Nunca aplique parâmetros diferentes por peer —
 * isso multiplica encoders e rouba CPU do jogo.
 */
async function adaptAll(senders: RTCRtpSender[], preset: EncodingPreset) {
  await Promise.all(senders.map(async (s) => {
    const params = s.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0]!.maxBitrate   = preset.maxBitrate;
    params.encodings[0]!.maxFramerate = preset.maxFramerate;
    params.degradationPreference = 'maintain-framerate';
    await s.setParameters(params);
  }));
}
```

Documente isso com comentário no código. É contraintuitivo e alguém vai tentar "otimizar" depois.

### 7.3 Guarda de banda

O upload do transmissor é o recurso escasso. Antes de aceitar cada novo espectador:

```ts
// core/media/bandwidth-probe.ts
export function maxPeersFor(uploadMbps: number, preset: EncodingPreset): number {
  const perPeerMbps = preset.maxBitrate / 1_000_000;
  const usable = uploadMbps * 0.75;          // margem para ACKs, jitter e o jogo
  return Math.max(1, Math.min(3, Math.floor(usable / perPeerMbps)));
}

export function selectPreset(uploadMbps: number): EncodingPreset {
  if (uploadMbps >= 12) return PRESET_1080P60;
  if (uploadMbps >= 6)  return PRESET_720P60;
  return PRESET_720P30;
}
```

O `bandwidth-probe` mede o upload real uma vez, no início da transmissão. Isso é regra pura e testável — mora em `core/`, não na UI.

### 7.4 ICE

```ts
// core/mesh/ice-config.ts
export function iceServers(turn?: TurnCredentials): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  if (turn) {
    servers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
  }
  return servers;
}
```

Credencial de TURN **nunca** vai hardcoded no bundle do front. O signaling entrega credencial efêmera no `hosting`/`watching`.

**Cota de TURN:** o free tier tem limite mensal. Instrumente `usingRelay` e mostre no HUD. Se a cota acabar, o produto degrada para "só conecta quem não precisa de relay" — trate isso como estado esperado, com mensagem clara, não como crash.

---

## 8. Ajustes de UI

| Onde | Mudança |
|---|---|
| HUD do transmissor | Mostrar `2/3` em vez de só a contagem. Upload agregado em Mbps. |
| HUD do transmissor | Ao detectar peer em relay, badge discreto: "1 espectador via relay" |
| Viewer, canal cheio | Estado próprio: "Transmissão lotada (3/3)" — não é erro genérico |
| Home | Após medir banda: "Seu upload comporta 720p60 · até 2 espectadores" com botão de forçar |
| Viewer | Latência exibida passa a ser RTT direto do peer — menor que antes, mostre com orgulho |

Nada disso muda a estrutura de componentes. Continuam burros.

---

## 9. Roadmap revisado

| Milestone | Estado | Conteúdo |
|---|---|---|
| M0 — Fundação | mantido | Monorepo, tsconfig, lint boundaries, CI |
| M1 — Domínio e signaling | **substitui M1+M2** | `core/domain/`, protocolo, `apps/signaling`, testes |
| M2 — Mesh | **novo, é o coração** | `PeerLink`, `MeshTopology`, `MeshTransport`, `BandwidthProbe` |
| M3 — Sessões e UI | ex-M3+M4 | `BroadcastSession` sobre mesh, hooks, componentes, rotas |
| M4 — Deploy | ex-M5, muito menor | Pages para o front, free tier para o signaling |

Seis milestones viram cinco, e os dois mais pesados (infra e API) desaparecem.

**O spike de latência continua bloqueante e humano**, entre M2 e M3. Em mesh o alvo cai: espere **80–150ms**, não 200ms. Se der acima de 250ms na mesma região, algo está errado.

---

## 10. Regras atualizadas do AGENTS.md

Substitua R2 e R5. As demais permanecem.

**R2 (nova) — nenhum SDK de SFU no projeto**

`core/` fala com `MediaTransport` e `SignalingChannel`. `livekit-client` não é dependência do projeto; `adapters/_reference/` é documentação, não código vivo. A implementação viva é `mesh-transport.ts`.

**R5 (nova) — três regras de mídia, agora quatro**

```ts
track.contentHint = 'motion';
degradationPreference: 'maintain-framerate';
videoCodec: 'h264';
// NOVA: parâmetros de encoding IDÊNTICOS para todos os peers
```

A quarta é a mais importante em mesh e a que mais parece errada à primeira vista. Adaptação é coletiva. Bitrate por peer = encoder por peer = FPS do jogo no chão.

**Nova R8 — o signaling nunca toca mídia**

O servidor de signaling repassa `payload` opaco. Não parseia SDP, não inspeciona ICE, não guarda histórico. Se você se pegar escrevendo lógica de mídia no servidor, parou de ser mesh.

---

## 11. Portfólio — o que destacar no README

O README é parte da entrega. Escreva-o pensando em quem vai avaliar o projeto.

Estruture em torno de:

1. **O problema real e datado** — ANPD, agosto de 2026. Projeto que resolve um problema concreto vale mais que um clone de Twitter.
2. **O diagrama de arquitetura com o seam explícito** — um núcleo de mídia, três transportes possíveis. Mostre que `BroadcastSession` não mudou uma linha quando o transporte inteiro foi trocado. Esse é o argumento mais forte do projeto.
3. **As decisões contraintuitivas com o porquê** — encoding idêntico entre peers, `contentHint = 'motion'`, duas camadas e não três. Detalhe específico demonstra profundidade melhor que qualquer lista de tecnologias.
4. **Os números medidos** — latência glass-to-glass com o método usado. Número medido vale dez adjetivos.
5. **As limitações declaradas** — teto de 3 espectadores, dependência de TURN de terceiro, upload como gargalo. Engenheiro sênior lê limitação declarada como sinal de maturidade; ausência dela como sinal de que ninguém mediu.
6. **Link para os ADRs.** `docs/adr/` com este changeset incluído é a evidência de processo.

Não escreva "projeto de estudos". Escreva o que ele faz e para quem.

---

## 13. O que continua verdadeiro

Nada disso mudou e continua valendo integralmente:

- Todas as regras de camada e o teste "apague `infra/`, tem que compilar"
- `Result` para erro esperado, `throw` só para bug e infra
- Branded types, sem barrel files, sem `any`
- Fakes em vez de mocks; testes de sessão sem browser
- Escopo fechado: sem chat, voz, contas, gravação, diretório
- `contentHint`, `degradationPreference`, H.264
- O documento de padrões de engenharia, na íntegra

A arquitetura mudou de transporte. Não mudou de princípios.
