import {
  type ClientMessage,
  ClientMessageSchema,
  HELLO_TIMEOUT_MS,
  P2P_LIMITS,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SignalingErrorCode,
  apelidoUnico,
} from '@tela/shared';
import { type Limits, RateBuckets, bytesDe } from './limits.js';
import type { IceProvisionResult } from './ice-provision.js';

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
  readonly participantId?: string;
  readonly attemptId?: string;
  /** Só espectador: apelido e sha256 da chave do navegador (ADR 0025). */
  readonly name?: string;
  readonly fingerprint?: string;
  /** Origem de rede (S-07): decide o teto de assentos por IP. */
  readonly ip: string;
};

/**
 * Um pedido para entrar, na mão do transmissor (ADR 0025).
 *
 * Sem vaga e sem credencial TURN: tudo isso só depois do `admit`. As duas
 * funções moram na closure da conexão do espectador — é ela que sabe
 * transformar o socket em peer.
 */
type Pedido = {
  readonly id: string;
  readonly socket: Socket;
  readonly name: string;
  readonly fingerprint: string;
  readonly participantId?: string;
  readonly ip: string;
  admitir(): void;
  recusar(code: SignalingErrorCode): void;
};

type Channel = {
  host: Peer | null;
  readonly viewers: Map<string, Peer>;
  readonly pedidos: Map<string, Pedido>;
  /** sha256 do ownerToken de quem reivindicou o canal. */
  ownerHash: string;
  /** Cada espectador passa pelo dono (ADR 0025). Desligado = sala aberta (ADR 0028). */
  aprovacao: boolean;
  /**
   * Teto de espectadores DESTE canal: o menor entre o do servidor e a
   * `capacidade` que o transmissor declarou (ADR 0029). Quem codifica uma vez
   * por espectador declara cinco; quem tem um encode e N envios, cinquenta.
   */
  teto: number;
  /**
   * O que a BANDA do transmissor paga agora (ADR 0030), por cima de `teto`.
   * `null` até ele mandar `capacidade`. Nunca passa de `teto`: a máquina
   * limita o que a banda pode abrir, e a banda só fecha.
   */
  tetoPelaBanda: number | null;
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
  readonly iceServersFor: (peerId: string) => IceProvisionResult;
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
  /** Baldes por IP e por slug (S-01, S-02): tudo o que é limite de ABUSO, não de protocolo. */
  const baldes = new RateBuckets(deps.now);

  function reap(name: string): void {
    const channel = channels.get(name);
    if (channel === undefined) return;
    if (channel.host !== null || channel.viewers.size > 0 || channel.pedidos.size > 0) return;
    if (channel.emptySince !== null && deps.now() - channel.emptySince < OWNERSHIP_GRACE_MS) {
      return; // ainda no período de carência do dono
    }
    channels.delete(name);
  }

  /** O que o transmissor precisa para reconhecer um espectador. */
  function quemE(viewer: Peer): { name?: string; fingerprint?: string } {
    return {
      ...(viewer.name === undefined ? {} : { name: viewer.name }),
      ...(viewer.fingerprint === undefined ? {} : { fingerprint: viewer.fingerprint }),
    };
  }

  function pedidoParaHost(p: Pedido): ServerMessage {
    return { type: 'join-request', peerId: p.id, name: p.name, fingerprint: p.fingerprint };
  }

  function peerIn(channel: Channel, id: string): Peer | null {
    if (channel.host?.id === id) return channel.host;
    return channel.viewers.get(id) ?? null;
  }

  /** O teto que vale na porta: servidor, máquina e banda — o menor dos três. */
  function tetoEfetivo(channel: Channel): number {
    return channel.tetoPelaBanda === null ? channel.teto : Math.min(channel.teto, channel.tetoPelaBanda);
  }

  function semVaga(channel: Channel): boolean {
    return channel.viewers.size >= tetoEfetivo(channel);
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
      /** Espectador esperando o transmissor responder. */
      let pedido: Pedido | null = null;
      let channelName: string | null = null;
      let closed = false;

      /**
       * Rate limit por CONEXÃO, não por IP: o custo de uma conexão barulhenta
       * fica com ela mesma. Janela fixa simples — não precisa ser justa, só
       * precisa impedir que um socket sozinho ocupe o event loop.
       */
      let windowStart = deps.now();
      let inWindow = 0;

      let refreshInicio = deps.now();
      let refreshes = 0;
      function refreshDaConexao(): boolean {
        const agora = deps.now();
        if (agora - refreshInicio >= deps.limits.refreshIceWindowMs) {
          refreshInicio = agora;
          refreshes = 0;
        }
        refreshes += 1;
        return refreshes <= deps.limits.refreshIceSocketLimit;
      }

      /** S-07: bytes de `signal` que ESTE espectador já mandou ao host na janela. */
      let signalBytes = 0;
      let signalInicio = deps.now();

      const cancelHelloTimer = deps.setTimer(HELLO_TIMEOUT_MS, () => {
        if (peer === null && pedido === null && !closed) fail('HELLO_TIMEOUT');
      });

      /** `maxPeers` só acompanha `CHANNEL_FULL`: o teto real, para a tela de "sem vaga". */
      function fail(code: SignalingErrorCode, maxPeers?: number): void {
        // Sem isto, toda conexão recusada segurava o timer até o fim e
        // disparava um segundo frame de erro num socket já fechado.
        cancelHelloTimer();
        socket.send({ type: 'error', code, ...(maxPeers === undefined ? {} : { maxPeers }) });
        socket.close();
      }

      /**
       * O teto do canal é o menor entre o do servidor e o que o transmissor
       * declarou. Sem declaração, o teto de quem codifica uma vez por
       * espectador: cliente antigo não manda `capacidade` e só conhecia cinco
       * vagas — dar cinquenta a ele seriam cinquenta encoders.
       */
      function tetoDoCanal(capacidade: number | undefined): number {
        return Math.min(deps.limits.maxPeers, capacidade ?? P2P_LIMITS.maxViewersSemUmEncode);
      }

      /**
       * Versão do cliente, antes de qualquer outra coisa. Sem o campo é v1,
       * que não conhece aprovação: recusado com um código que ele entende.
       */
      function versaoRecusada(protocol: number | undefined): SignalingErrorCode | null {
        if (protocol === undefined) return 'BAD_MESSAGE';
        return protocol === PROTOCOL_VERSION ? null : 'PROTOCOL_MISMATCH';
      }

      function claimChannel(
        slug: string, ownerToken: string, protocol: number | undefined, aprovacao: boolean,
        capacidade: number | undefined,
      ): void {
        const versao = versaoRecusada(protocol);
        if (versao !== null) return fail(versao);
        if (!deps.isValidSlug(slug)) return fail('SLUG_INVALID');

        /*
          S-01: a posse é checada ANTES de qualquer contagem, e só a FALHA
          conta. Antes, toda tentativa (inclusive a do dono) gastava o balde
          do IP, e 20 `host` com token errado, de qualquer lugar, trancavam o
          dono fora do próprio slug — e, passada a carência, o atacante levava
          o link. Agora o token certo passa sempre, por mais que se erre.
        */
        const ownerHash = deps.hash(ownerToken);
        const existing = channels.get(slug);
        const ehDono = existing !== undefined && deps.equals(existing.ownerHash, ownerHash);

        if (existing !== undefined && !ehDono) {
          // Dono errado: é o único caminho que gasta balde. Estourou, o erro
          // muda de SLUG_TAKEN para RATE_LIMITED — nunca para "pode entrar".
          const dentro =
            baldes.take(`falha:${remoteAddress}`, deps.limits.falhaHostLimit, deps.limits.hostWindowMs) &&
            baldes.take(`falha-slug:${slug}`, deps.limits.falhaHostSlugLimit, deps.limits.hostWindowMs);
          return fail(dentro ? 'SLUG_TAKEN' : 'RATE_LIMITED');
        }

        /*
          Slug LIVRE: é aqui que mora o squatting, e o limite por IP vale
          (rajada por minuto + acúmulo por hora). Reconexão do dono não passa
          por este ponto.
        */
        if (
          existing === undefined &&
          !(baldes.take(`host:${remoteAddress}`, deps.limits.hostLimit, deps.limits.hostWindowMs) &&
            baldes.take(`host-h:${remoteAddress}`, deps.limits.slugsNovosPorHoraLimit, deps.limits.slugsNovosJanelaMs))
        ) {
          return fail('RATE_LIMITED');
        }

        const teto = tetoDoCanal(capacidade);

        if (existing !== undefined) {
          // Mesmo dono: derruba o socket velho e assume. Cobre refresh de
          // página, crash do browser e troca de rede.
          existing.host?.socket.close();
          peer = { id: deps.newPeerId('h'), role: 'host', socket, ip: remoteAddress };
          existing.host = peer;
          existing.emptySince = null;
          existing.aprovacao = aprovacao;
          // Quem voltou com teto menor não expulsa ninguém: só não entra mais.
          existing.teto = teto;
          // A banda é medida pela sessão nova; ela manda `capacidade` de novo.
          existing.tetoPelaBanda = null;
        } else {
          peer = { id: deps.newPeerId('h'), role: 'host', socket, ip: remoteAddress };
          channels.set(slug, {
            host: peer,
            viewers: new Map(),
            pedidos: new Map(),
            ownerHash,
            aprovacao,
            teto,
            tetoPelaBanda: null,
            emptySince: null,
          });
        }

        channelName = slug;
        cancelHelloTimer();
        const ice = deps.iceServersFor(peer.id);
        socket.send({
          type: 'hosting',
          peerId: peer.id,
          iceServers: [...ice.servers],
          relayStatus: ice.relayStatus,
          ...(ice.issuedAt === undefined ? {} : { issuedAt: ice.issuedAt }),
          ...(ice.expiresAt === undefined ? {} : { expiresAt: ice.expiresAt }),
          maxPeers: teto,
        });

        /**
         * Reapresenta quem já está assistindo.
         *
         * O transmissor é quem oferece a mídia. Sem isto, um host que
         * reconectou nunca ofertava para os espectadores que continuaram no
         * canal — eles seguravam vaga com uma conexão morta até o ICE
         * desistir, e nada na tela dizia o motivo.
         */
        for (const viewer of existing?.viewers.values() ?? []) {
          socket.send({ type: 'peer-joined', peerId: viewer.id, ...quemE(viewer) });
        }
        // Pedidos que esperavam o transmissor voltar continuam de pé — ou
        // entram de uma vez, se ele voltou com a sala aberta.
        for (const p of [...(existing?.pedidos.values() ?? [])]) {
          if (aprovacao) socket.send(pedidoParaHost(p));
          else p.admitir();
        }
      }

      /**
       * Avisa a plateia do tamanho dela.
       *
       * Só para espectadores: o transmissor já acompanha por
       * `peer-joined`/`peer-left`, que carregam os ids de que ele precisa
       * para negociar mídia.
       */
      /** `leave` recebido: saída anunciada, não queda de socket. */
      let saiuDeProposito = false;

      function anunciarPlateia(channel: Channel): void {
        const count = channel.viewers.size;
        for (const viewer of channel.viewers.values()) {
          viewer.socket.send({ type: 'viewers', count });
        }
      }

      function assentosDoIp(channel: Channel): number {
        return [...channel.viewers.values()].filter((v) => v.ip === remoteAddress).length;
      }

      function pedidosDoIp(channel: Channel): number {
        return [...channel.pedidos.values()].filter((p) => p.ip === remoteAddress).length;
      }

      function joinChannel(
        slug: string, protocol: number | undefined,
        participantId?: string, attemptId?: string, name?: string, viewerKey?: string,
      ): void {
        const versao = versaoRecusada(protocol);
        if (versao !== null) return fail(versao);
        if (!deps.isValidSlug(slug)) return fail('SLUG_INVALID');

        const channel = channels.get(slug);
        const host = channel?.host;
        // Slug inválido, inexistente e offline devolvem o MESMO erro: quem
        // varre nomes não distingue "não existe" de "existe e está fora do ar".
        if (channel === undefined || host == null) return fail('NOT_HOSTING');
        /*
          Sem convite desde a ADR 0026: o link é só o nome, e a porta é a
          aprovação do dono logo abaixo — que já vem antes de vaga e de
          credencial TURN.
        */
        /*
          Sala aberta (ADR 0028): quem tem o link entra direto — vaga,
          credencial e `watching`, como antes da ADR 0025. Retomada pelo
          `participantId`, que já é um segredo de alta entropia do navegador.
        */
        if (!channel.aprovacao) {
          const impressao = viewerKey === undefined ? undefined : deps.hash(viewerKey);
          const anterior = participantId === undefined ? undefined : [...channel.viewers.values()]
            .find((viewer) => viewer.participantId === participantId);
          channelName = slug;
          cancelHelloTimer();
          if (anterior !== undefined) return entrar(channel, anterior.id, name, impressao, participantId, attemptId, anterior);
          if (semVaga(channel)) return fail('CHANNEL_FULL', tetoEfetivo(channel));
          // S-07: um IP não toma o canal inteiro. Vale só na sala aberta.
          if (assentosDoIp(channel) >= deps.limits.viewersPorIp) return fail('RATE_LIMITED');
          return entrar(channel, deps.newPeerId('v'), name, impressao, participantId, attemptId, undefined);
        }

        // Sem apelido e chave não há o que mostrar ao transmissor (ADR 0025).
        if (name === undefined || viewerKey === undefined) return fail('BAD_MESSAGE');
        const fingerprint = deps.hash(viewerKey);

        /*
          Retomada: o MESMO navegador (chave e participante) cujo socket caiu e
          voltou antes de o servidor notar. Já foi aceito — pedir de novo por
          uma piscada de rede seria punir a pessoa pela rede dela.
        */
        const previous = participantId === undefined ? undefined : [...channel.viewers.values()]
          .find((viewer) => viewer.participantId === participantId &&
            viewer.fingerprint !== undefined && deps.equals(viewer.fingerprint, fingerprint));
        channelName = slug;
        cancelHelloTimer();
        if (previous !== undefined) return entrar(channel, previous.id, name, fingerprint, participantId, attemptId, previous);

        if (semVaga(channel)) return fail('CHANNEL_FULL', tetoEfetivo(channel));

        // O mesmo pedido chegando por outro socket substitui o anterior.
        const repetido = participantId === undefined ? undefined : [...channel.pedidos.values()]
          .find((p) => p.participantId === participantId && deps.equals(p.fingerprint, fingerprint));
        if (repetido === undefined && channel.pedidos.size >= deps.limits.maxPending) return fail('RATE_LIMITED');
        // S-07: um IP também não enche a fila do dono de pedidos.
        if (repetido === undefined && pedidosDoIp(channel) >= deps.limits.viewersPorIp) return fail('RATE_LIMITED');

        const id = repetido?.id ?? deps.newPeerId('v');
        if (repetido !== undefined) {
          channel.pedidos.delete(repetido.id);
          repetido.socket.close();
        }
        // S-20: dois "Maria" diante do dono seriam indistinguíveis; o segundo vira "Maria (2)".
        const ocupados = [
          ...[...channel.viewers.values()].flatMap((v) => (v.name === undefined ? [] : [v.name])),
          ...[...channel.pedidos.values()].map((p) => p.name),
        ];
        name = apelidoUnico(name, ocupados);
        const meu: Pedido = {
          id, socket, name, fingerprint, ip: remoteAddress,
          ...(participantId === undefined ? {} : { participantId }),
          admitir: () => {
            if (pedido !== meu || closed) return;
            pedido = null;
            channel.pedidos.delete(id);
            // A vaga é conferida de novo: pode ter enchido enquanto esperava.
            if (semVaga(channel)) {
              channel.host?.socket.send({ type: 'join-cancelled', peerId: id });
              return fail('CHANNEL_FULL', tetoEfetivo(channel));
            }
            entrar(channel, id, name, fingerprint, participantId, attemptId, undefined);
          },
          recusar: (code) => {
            if (pedido !== meu || closed) return;
            pedido = null;
            channel.pedidos.delete(id);
            fail(code);
          },
        };
        pedido = meu;
        channel.pedidos.set(id, meu);
        socket.send({ type: 'awaiting-approval' });
        host.socket.send(pedidoParaHost(meu));
      }

      /** Da aprovação (ou da retomada) em diante: vaga, credencial, `watching`. */
      function entrar(
        channel: Channel, id: string, name: string | undefined, fingerprint: string | undefined,
        participantId: string | undefined, attemptId: string | undefined, previous: Peer | undefined,
      ): void {
        const host = channel.host;
        if (host === null) return fail('NOT_HOSTING');
        // S-02: cada entrada emite credencial TURN; o IP tem orçamento delas.
        if (!baldes.take(`watch:${remoteAddress}`, deps.limits.watchIpLimit, deps.limits.watchIpWindowMs)) {
          return fail('RATE_LIMITED');
        }
        peer = {
          id, role: 'viewer', socket, ip: remoteAddress,
          ...(name === undefined ? {} : { name }),
          ...(fingerprint === undefined ? {} : { fingerprint }),
          ...(participantId === undefined ? {} : { participantId }),
          ...(attemptId === undefined ? {} : { attemptId }),
        };
        channel.viewers.set(peer.id, peer);
        previous?.socket.close();
        const ice = deps.iceServersFor(peer.id);

        socket.send({
          type: 'watching',
          peerId: peer.id,
          hostId: host.id,
          iceServers: [...ice.servers],
          relayStatus: ice.relayStatus,
          ...(ice.issuedAt === undefined ? {} : { issuedAt: ice.issuedAt }),
          ...(ice.expiresAt === undefined ? {} : { expiresAt: ice.expiresAt }),
          viewers: channel.viewers.size,
        });
        // O transmissor é quem oferece — ele tem a mídia.
        host.socket.send({
          type: 'peer-joined', peerId: peer.id,
          ...(attemptId === undefined ? {} : { attemptId }),
          ...quemE(peer),
        });
        anunciarPlateia(channel);
      }

      /** Só o transmissor atual responde a pedido. Pedido sumido é silêncio. */
      function responder(peerId: string, aceitar: boolean): void {
        if (peer === null || channelName === null || peer.role !== 'host') return fail('BAD_MESSAGE');
        const channel = channels.get(channelName);
        if (channel === undefined || channel.host !== peer) return;
        const alvo = channel.pedidos.get(peerId);
        if (alvo === undefined) return;
        if (aceitar) alvo.admitir();
        else alvo.recusar('DENIED');
      }

      /**
       * Só o transmissor atual tira espectadores: a sinalização fecha aqui, e o
       * `peer-left` faz o transmissor fechar o peer do lado dele.
       */
      function removeViewers(peerId: string | undefined): void {
        if (peer === null || channelName === null || peer.role !== 'host') return fail('BAD_MESSAGE');
        const channel = channels.get(channelName);
        if (channel === undefined || channel.host !== peer) return;
        const alvo = peerId === undefined
          ? [...channel.viewers.values()]
          : [channel.viewers.get(peerId)].filter((v): v is Peer => v !== undefined);
        for (const viewer of alvo) {
          channel.viewers.delete(viewer.id);
          viewer.socket.send({ type: 'error', code: 'REMOVED' });
          viewer.socket.close();
          socket.send({ type: 'peer-left', peerId: viewer.id });
        }
        if (alvo.length > 0) anunciarPlateia(channel);
      }

      /**
       * Só o transmissor atual mexe no teto pela banda (ADR 0030). Nunca acima
       * do que a máquina declarou, e sem tirar ninguém: a vaga de quem já
       * está é dele; o número só decide quem AINDA entra.
       */
      function atualizarCapacidade(valor: number): void {
        if (peer === null || channelName === null || peer.role !== 'host') return fail('BAD_MESSAGE');
        const channel = channels.get(channelName);
        if (channel === undefined || channel.host !== peer) return;
        channel.tetoPelaBanda = Math.min(channel.teto, valor);
      }

      /** Espectador só fala com o transmissor; transmissor endereça por `to`. */
      function resolveTarget(channel: Channel, to: string | undefined, self: Peer): Peer | null {
        if (self.role === 'viewer') return channel.host;
        return to === undefined ? null : (channel.viewers.get(to) ?? null);
      }

      function relay(message: Extract<ClientMessage, { type: 'signal' }>, bytes: number): void {
        if (peer === null || channelName === null) return fail('BAD_MESSAGE');
        if (peer.role === 'viewer') {
          // S-07: o host paga cada byte que um espectador manda. Frame grande
          // demais é abuso (SDP legítimo é pequeno); volume demais também.
          if (bytes > deps.limits.viewerSignalMaxBytes) return fail('BAD_MESSAGE');
          const agora = deps.now();
          if (agora - signalInicio >= deps.limits.messageWindowMs) {
            signalInicio = agora;
            signalBytes = 0;
          }
          signalBytes += bytes;
          if (signalBytes > deps.limits.viewerSignalBytesPorJanela) return fail('RATE_LIMITED');
        }
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
          // O transmissor negocia com a plateia inteira; o espectador, com um peer.
          const teto = peer?.role === 'host' ? deps.limits.hostMessageLimit : deps.limits.messageLimit;
          if (inWindow > teto) return fail('RATE_LIMITED');

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
              return claimChannel(
                message.slug, message.ownerToken, message.protocol, message.approval === true, message.capacidade,
              );
            case 'watch':
              if (peer !== null || pedido !== null) return;
              return joinChannel(
                message.slug, message.protocol,
                message.participantId, message.attemptId, message.name, message.viewerKey,
              );
            case 'admit':
              return responder(message.peerId, true);
            case 'deny':
              return responder(message.peerId, false);
            case 'remove-viewers':
              return removeViewers(message.peerId);
            case 'capacidade':
              return atualizarCapacidade(message.valor);
            case 'refresh-ice': {
              if (peer === null || channelName === null) return fail('BAD_MESSAGE');
              const current = channels.get(channelName);
              if (current === undefined || peerIn(current, peer.id) !== peer) return;
              /*
                S-02: cada refresh é uma credencial TURN paga. Estourou o teto
                da conexão ou do IP: silêncio, sem emitir e sem fechar — o
                cliente tem timeout e tenta de novo no ciclo seguinte, e
                derrubar um espectador por excesso de renovação puniria a
                vítima de um cliente com defeito.
              */
              if (!refreshDaConexao()) return;
              if (!baldes.take(`refresh:${remoteAddress}`, deps.limits.refreshIceIpLimit, deps.limits.refreshIceWindowMs)) return;
              const ice = deps.iceServersFor(peer.id);
              socket.send({
                type: 'ice-servers', requestId: message.requestId,
                iceServers: [...ice.servers], relayStatus: ice.relayStatus,
                ...(ice.issuedAt === undefined ? {} : { issuedAt: ice.issuedAt }),
                ...(ice.expiresAt === undefined ? {} : { expiresAt: ice.expiresAt }),
              });
              return;
            }
            case 'signal':
              if (peer === null) return fail('BAD_MESSAGE');
              return relay(message, bytesDe(raw));
            case 'leave':
              // Marca ANTES de fechar: é o que separa "eu parei" de "meu
              // socket caiu", e as duas coisas pedem reações opostas.
              saiuDeProposito = true;
              return socket.close();
          }
        },

        disconnect(): void {
          if (closed) return;
          closed = true;
          cancelHelloTimer();
          if (pedido !== null && channelName !== null) {
            // Desistiu (ou caiu) antes da resposta: some da fila do transmissor.
            const channel = channels.get(channelName);
            if (channel?.pedidos.get(pedido.id) === pedido) {
              channel.pedidos.delete(pedido.id);
              channel.host?.socket.send({ type: 'join-cancelled', peerId: pedido.id });
              reap(channelName);
            }
            pedido = null;
            return;
          }
          if (peer === null || channelName === null) return;

          const channel = channels.get(channelName);
          if (channel === undefined) return;
          // Já substituído por uma reconexão: o `disconnect` atrasado do
          // socket velho não pode destruir o canal do novo.
          if (peerIn(channel, peer.id) !== peer) return;

          if (peer.role === 'host') {
            channel.host = null;
            channel.emptySince = deps.now();

            /**
             * Socket do transmissor que CAIU não derruba a plateia.
             *
             * A mídia é direta entre os dois: o servidor nunca esteve no
             * caminho dela, então não deveria estar no caminho da falha. Ao
             * derrubar os espectadores aqui, uma piscada de rede do
             * transmissor — ou um deploy nosso — apagava transmissões que
             * continuavam funcionando perfeitamente. Medido: 5 segundos de
             * tela morta e conexões duplicadas quando o transmissor voltava
             * com um `peerId` novo e era admitido como se fosse outro peer.
             *
             * Quem detecta saída de verdade é o próprio espectador, pela
             * MÍDIA: a trilha remota termina e ele reage na hora. É o sinal
             * certo, porque é o que ele está de fato consumindo.
             *
             * A reapresentação em `claimChannel` só existe por causa disto —
             * enquanto a plateia era limpa aqui, ela iterava mapa vazio.
             */
            if (saiuDeProposito) {
              for (const viewer of channel.viewers.values()) {
                // Saída anunciada: aí sim avisa e fecha, sem esperar a mídia
                // morrer sozinha.
                viewer.socket.send({ type: 'peer-left', peerId: peer.id });
                viewer.socket.close();
              }
              channel.viewers.clear();
              // Quem esperava resposta não vai ter: não há mais transmissão.
              for (const p of [...channel.pedidos.values()]) p.recusar('NOT_HOSTING');
              channel.pedidos.clear();
            }
          } else {
            channel.viewers.delete(peer.id);
            channel.host?.socket.send({ type: 'peer-left', peerId: peer.id });
            anunciarPlateia(channel);
          }
          reap(channelName);
        },
      };
    },
  };
}

export type ChannelRegistry = ReturnType<typeof makeChannelRegistry>;
