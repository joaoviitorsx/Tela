import {
  type ClientMessage,
  ClientMessageSchema,
  HELLO_TIMEOUT_MS,
  type IceServerConfig,
  type ServerMessage,
  type SignalingErrorCode,
} from '@tela/shared';
import { type Limits, RateBuckets } from './limits.js';

/**
 * Registro de canais do mesh.
 *
 * Este é o servidor inteiro. Ele roteia `payload` opaco entre o transmissor e
 * cada espectador, e nunca olha dentro (R8). Não persiste nada: um `Map` em
 * memória, que esvazia no restart.
 *
 * Consequência de arquitetura que vale conhecer: se este processo cair no meio
 * de uma transmissão, as `RTCPeerConnection` já estabelecidas continuam
 * funcionando — só espectadores novos não entram. O servidor não está no
 * caminho da mídia, então não está no caminho da falha.
 *
 * Deliberadamente ignorante de WebSocket: recebe `Socket`, uma interface de
 * duas funções. É isso que permite testar o roteamento inteiro sem rede.
 */
export type Socket = {
  send(message: ServerMessage): void;
  close(): void;
};

type Peer = {
  readonly id: string;
  readonly role: 'host' | 'viewer';
  readonly socket: Socket;
};

type Channel = {
  host: Peer | null;
  readonly viewers: Map<string, Peer>;
  /** sha256 do ownerToken de quem reivindicou o canal. */
  ownerHash: string;
  /** Momento em que o canal ficou sem transmissor. `null` enquanto há um. */
  emptySince: number | null;
};

export type RegistryDeps = {
  readonly limits: Limits;
  readonly now: () => number;
  /** sha256 hex. Injetado para o teste não depender de `node:crypto`. */
  readonly hash: (input: string) => string;
  /** Comparação em tempo constante. */
  readonly equals: (a: string, b: string) => boolean;
  readonly isValidSlug: (slug: string) => boolean;
  /** Credenciais efêmeras, geradas por conexão. */
  readonly iceServersFor: (peerId: string) => IceServerConfig[];
  readonly setTimer: (ms: number, task: () => void) => () => void;
  /** Identidade curta e imprevisível de peer. Injetada para o teste ser determinístico. */
  readonly newPeerId: (prefix: string) => string;
};

export type Connection = {
  /** Chame com o texto cru recebido do socket. */
  receive(raw: string): void;
  /** Chame quando o socket fechar, por qualquer motivo. */
  disconnect(): void;
};

/**
 * Depois que o transmissor sai, o canal guarda o dono por este tempo.
 *
 * Sem isso, um refresh de página ou um crash do browser devolveria o slug para
 * o primeiro estranho que o pedisse — e o link que a pessoa já mandou para os
 * amigos passaria a apontar para outra transmissão. Cinco minutos cobrem
 * reconexão humana sem transformar o registro em armazenamento persistente:
 * reiniciar o processo continua limpando tudo.
 */
export const OWNERSHIP_GRACE_MS = 5 * 60_000;

export function makeChannelRegistry(deps: RegistryDeps) {
  const channels = new Map<string, Channel>();
  const hostAttempts = new RateBuckets(deps.now);

  function reap(name: string): void {
    const channel = channels.get(name);
    if (channel === undefined) return;
    if (channel.host !== null || channel.viewers.size > 0) return;
    if (channel.emptySince !== null && deps.now() - channel.emptySince < OWNERSHIP_GRACE_MS) {
      return; // ainda no período de carência do dono
    }
    channels.delete(name);
  }

  function peerIn(channel: Channel, id: string): Peer | null {
    if (channel.host?.id === id) return channel.host;
    return channel.viewers.get(id) ?? null;
  }

  return {
    get channelCount(): number {
      return channels.size;
    },
    viewerCount(slug: string): number {
      return channels.get(slug)?.viewers.size ?? 0;
    },
    isHosting(slug: string): boolean {
      return channels.get(slug)?.host != null;
    },
    /** Chamado por um relógio externo: descarta canais fora da carência. */
    sweep(): void {
      for (const name of [...channels.keys()]) reap(name);
    },

    accept(socket: Socket, remoteAddress: string): Connection {
      let peer: Peer | null = null;
      let channelName: string | null = null;
      let closed = false;

      /**
       * Rate limit por CONEXÃO, não por IP: o custo de uma conexão barulhenta
       * fica com ela mesma. Janela fixa simples — não precisa ser justa, só
       * precisa impedir que um socket sozinho ocupe o event loop.
       */
      let windowStart = deps.now();
      let inWindow = 0;

      const cancelHelloTimer = deps.setTimer(HELLO_TIMEOUT_MS, () => {
        if (peer === null && !closed) fail('HELLO_TIMEOUT');
      });

      function fail(code: SignalingErrorCode): void {
        // Sem isto, toda conexão recusada segurava o timer até o fim e
        // disparava um segundo frame de erro num socket já fechado.
        cancelHelloTimer();
        socket.send({ type: 'error', code });
        socket.close();
      }

      function claimChannel(slug: string, ownerToken: string): void {
        if (!deps.isValidSlug(slug)) return fail('SLUG_INVALID');
        if (!hostAttempts.take(`host:${remoteAddress}`, deps.limits.hostLimit, deps.limits.hostWindowMs)) {
          return fail('RATE_LIMITED');
        }

        const ownerHash = deps.hash(ownerToken);
        const existing = channels.get(slug);

        if (existing !== undefined) {
          if (!deps.equals(existing.ownerHash, ownerHash)) return fail('SLUG_TAKEN');
          // Mesmo dono: derruba o socket velho e assume. Cobre refresh de
          // página, crash do browser e troca de rede.
          existing.host?.socket.close();
          peer = { id: deps.newPeerId('h'), role: 'host', socket };
          existing.host = peer;
          existing.emptySince = null;
        } else {
          peer = { id: deps.newPeerId('h'), role: 'host', socket };
          channels.set(slug, {
            host: peer,
            viewers: new Map(),
            ownerHash,
            emptySince: null,
          });
        }

        channelName = slug;
        cancelHelloTimer();
        socket.send({
          type: 'hosting',
          peerId: peer.id,
          iceServers: deps.iceServersFor(peer.id),
          maxPeers: deps.limits.maxPeers,
        });
      }

      function joinChannel(slug: string): void {
        if (!deps.isValidSlug(slug)) return fail('SLUG_INVALID');

        const channel = channels.get(slug);
        const host = channel?.host;
        // Slug inválido, inexistente e offline devolvem o MESMO erro: quem
        // varre nomes não distingue "não existe" de "existe e está fora do ar".
        if (channel === undefined || host == null) return fail('NOT_HOSTING');
        if (channel.viewers.size >= deps.limits.maxPeers) return fail('CHANNEL_FULL');

        peer = { id: deps.newPeerId('v'), role: 'viewer', socket };
        channel.viewers.set(peer.id, peer);
        channelName = slug;
        cancelHelloTimer();

        socket.send({
          type: 'watching',
          peerId: peer.id,
          hostId: host.id,
          iceServers: deps.iceServersFor(peer.id),
        });
        // O transmissor é quem oferece — ele tem a mídia.
        host.socket.send({ type: 'peer-joined', peerId: peer.id });
      }

      /** Espectador só fala com o transmissor; transmissor endereça por `to`. */
      function resolveTarget(channel: Channel, to: string | undefined, self: Peer): Peer | null {
        if (self.role === 'viewer') return channel.host;
        return to === undefined ? null : (channel.viewers.get(to) ?? null);
      }

      function relay(message: Extract<ClientMessage, { type: 'signal' }>): void {
        if (peer === null || channelName === null) return fail('BAD_MESSAGE');
        const channel = channels.get(channelName);
        if (channel === undefined) return;
        // Um socket desalojado por outra conexão não fala mais em nome do peer.
        if (peerIn(channel, peer.id) !== peer) return;

        const target = resolveTarget(channel, message.to, peer);
        if (target === null) return;
        // `payload` atravessa sem ser lido. R8.
        target.socket.send({ type: 'signal', from: peer.id, payload: message.payload });
      }

      return {
        receive(raw: string): void {
          if (closed) return;

          const now = deps.now();
          if (now - windowStart >= deps.limits.messageWindowMs) {
            windowStart = now;
            inWindow = 0;
          }
          inWindow += 1;
          if (inWindow > deps.limits.messageLimit) return fail('RATE_LIMITED');

          let json: unknown;
          try {
            json = JSON.parse(raw);
          } catch {
            return fail('BAD_MESSAGE');
          }

          const parsed = ClientMessageSchema.safeParse(json);
          if (!parsed.success) return fail('BAD_MESSAGE');

          const message = parsed.data;
          switch (message.type) {
            case 'host':
              if (peer !== null) return;
              return claimChannel(message.slug, message.ownerToken);
            case 'watch':
              if (peer !== null) return;
              return joinChannel(message.slug);
            case 'signal':
              if (peer === null) return fail('BAD_MESSAGE');
              return relay(message);
            case 'leave':
              return socket.close();
          }
        },

        disconnect(): void {
          if (closed) return;
          closed = true;
          cancelHelloTimer();
          if (peer === null || channelName === null) return;

          const channel = channels.get(channelName);
          if (channel === undefined) return;
          // Já substituído por uma reconexão: o `disconnect` atrasado do
          // socket velho não pode destruir o canal do novo.
          if (peerIn(channel, peer.id) !== peer) return;

          if (peer.role === 'host') {
            channel.host = null;
            channel.emptySince = deps.now();
            for (const viewer of channel.viewers.values()) {
              /**
               * AVISA antes de fechar.
               *
               * Fechar o socket calado deixa o espectador sem saber se o
               * transmissor saiu ou se o servidor caiu — e as duas coisas
               * pedem reações opostas: no primeiro caso a mídia acabou, no
               * segundo ela continua. Sem o aviso, ele ficava "assistindo"
               * um vídeo congelado.
               */
              viewer.socket.send({ type: 'peer-left', peerId: peer.id });
              viewer.socket.close();
            }
            channel.viewers.clear();
          } else {
            channel.viewers.delete(peer.id);
            channel.host?.socket.send({ type: 'peer-left', peerId: peer.id });
          }
          reap(channelName);
        },
      };
    },
  };
}

export type ChannelRegistry = ReturnType<typeof makeChannelRegistry>;
