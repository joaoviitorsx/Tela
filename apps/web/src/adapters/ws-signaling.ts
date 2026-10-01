import {
  type ClientMessage,
  HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageSchema,
} from '@tela/shared';
import { Emitter } from '../core/emitter.js';
import type {
  ChannelEvents,
  ChannelOpened,
  IceCredentials,
  SignalingChannel,
  SignalingError,
} from '../core/ports/signaling-channel.js';

/**
 * `SignalingChannel` sobre WebSocket, com reconexão.
 *
 * Único arquivo do front que sabe que WebSocket existe. O núcleo fala com a
 * porta; trocar por um broker gerenciado é reescrever só este arquivo — e a
 * reconexão mora aqui pelo mesmo motivo: é detalhe de transporte, não regra
 * de produto.
 */

/**
 * Reconexão com backoff.
 *
 * O caso que motivou: o servidor reinicia por dois segundos — um deploy — e o
 * transmissor ficava sem canal PELO RESTO DA SESSÃO. A mídia já estabelecida
 * continuava (é o que a arquitetura promete), mas nenhum espectador novo
 * entrava nunca mais, e a única saída era parar e recomeçar, derrubando
 * justamente quem estava assistindo.
 */
const RECONECTAR_MIN_MS = 1_000;
const RECONECTAR_MAX_MS = 15_000;
const RECONECTAR_FATOR = 1.8;

/**
 * Erros em que insistir não adianta: o canal não é mais nosso, ou nunca foi.
 * Ficar tentando para sempre esconderia do usuário que ele perdeu o slug.
 */
const NAO_ADIANTA_INSISTIR: ReadonlySet<string> = new Set([
  'SLUG_TAKEN',
  'SLUG_INVALID',
  // Espectador tirado, cliente de outra versão: reconectar sozinho com a
  // mesma saudação daria o mesmo não.
  'REMOVED',
  'PROTOCOL_MISMATCH',
  // Recusado pelo transmissor: pedir de novo é escolha da pessoa, não do laço.
  'DENIED',
]);

export function makeWsSignaling(baseUrl: string): SignalingChannel {
  const emitter = new Emitter<ChannelEvents>();

  let socket: WebSocket | null = null;
  let opened = false;
  let closedByUs = false;

  /** A mesma reivindicação, guardada para refazer depois de uma queda. */
  let saudacao: ClientMessage | null = null;
  /** Já emitimos um `closed` definitivo: o eco do socket não deve repetir. */
  let encerrado = false;
  let slugAtual = '';
  let tentativa = 0;
  let religar: number | null = null;
  let pendingRefresh: {
    requestId: string;
    promise: Promise<IceCredentials>;
    resolve: (value: IceCredentials) => void;
    reject: (reason: SignalingError) => void;
    timer: number;
  } | null = null;

  function failRefresh(): void {
    const pending = pendingRefresh;
    if (pending === null) return;
    pendingRefresh = null;
    window.clearTimeout(pending.timer);
    pending.reject({ code: 'SIGNAL_UNREACHABLE' });
  }

  /**
   * O slug vai NA URL, além de ir na primeira mensagem.
   *
   * Não é redundância: em Durable Objects o caminho é o que decide qual
   * instância atende (`idFromName`), então sem ele todos os canais cairiam no
   * mesmo objeto. O servidor portátil ignora o caminho, e o Worker valida que
   * os dois batem — cliente que diverge é confuso ou malicioso.
   */
  const endpoint = (slug: string) => `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(slug)}`;

  function conectar(
    hello: ClientMessage,
    slug: string,
    aoAbrir: (aberto: ChannelOpened) => void,
    aoFalhar: (erro: SignalingError) => void,
  ): void {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint(slug));
    } catch {
      // Navegador que recusa abrir o socket (política, esquema bloqueado):
      // não conseguimos falar com o servidor, e isso não é "sem transmissão".
      aoFalhar({ code: 'SIGNAL_UNREACHABLE' });
      return;
    }
    socket = ws;

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      // Servidor aceitou o socket e nunca respondeu. Sem este relógio a
      // promessa não resolve nem rejeita, e a UI fica presa em "conectando".
      ws.close();
      aoFalhar({ code: 'HELLO_TIMEOUT' });
    }, HELLO_TIMEOUT_MS * 2);

    ws.addEventListener('open', () => {
      if (socket === ws) ws.send(JSON.stringify(hello));
    });

    ws.addEventListener('message', (event) => {
      if (socket !== ws) return;
      let json: unknown;
      try {
        json = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(json);
      if (!parsed.success) return;
      const message: ServerMessage = parsed.data;

      if (!settled) {
        if (message.type === 'hosting') {
          settled = true;
          opened = true;
          window.clearTimeout(timer);
          aoAbrir({
            role: 'host',
            selfId: message.peerId,
            hostId: null,
            iceServers: message.iceServers,
            issuedAt: message.issuedAt,
            expiresAt: message.expiresAt,
            ...(message.relayStatus === undefined ? {} : { relayStatus: message.relayStatus }),
            maxPeers: message.maxPeers,
            viewers: 0,
          });
          return;
        }
        if (message.type === 'watching') {
          settled = true;
          opened = true;
          window.clearTimeout(timer);
          aoAbrir({
            role: 'viewer',
            selfId: message.peerId,
            hostId: message.hostId,
            iceServers: message.iceServers,
            issuedAt: message.issuedAt,
            expiresAt: message.expiresAt,
            ...(message.relayStatus === undefined ? {} : { relayStatus: message.relayStatus }),
            maxPeers: 0,
            viewers: message.viewers,
          });
          return;
        }
        if (message.type === 'error') {
          settled = true;
          window.clearTimeout(timer);
          ws.close();
          aoFalhar({ code: message.code, maxPeers: message.maxPeers });
          return;
        }
        /*
          O pedido está com o transmissor, que pode estar no meio de uma
          partida: esperar é o caminho normal, não servidor mudo. O relógio de
          saudação para aqui, e a promessa só resolve no `watching`.
        */
        if (message.type === 'awaiting-approval') {
          window.clearTimeout(timer);
          emitter.emit('aguardando-aprovacao', undefined);
          return;
        }
      }

      switch (message.type) {
        case 'peer-joined':
          return emitter.emit('peer-joined', {
            peerId: message.peerId, attemptId: message.attemptId,
            nome: message.name, impressao: message.fingerprint,
          });
        case 'join-request':
          return emitter.emit('pedido', {
            peerId: message.peerId, nome: message.name, impressao: message.fingerprint,
          });
        case 'join-cancelled':
          return emitter.emit('pedido-cancelado', { peerId: message.peerId });
        case 'peer-left':
          return emitter.emit('peer-left', { peerId: message.peerId });
        case 'viewers':
          return emitter.emit('viewers', { count: message.count });
        case 'signal':
          return emitter.emit('signal', { from: message.from, payload: message.payload });
        case 'ice-servers': {
          const pending = pendingRefresh;
          if (pending === null || pending.requestId !== message.requestId) return;
          pendingRefresh = null;
          window.clearTimeout(pending.timer);
          pending.resolve(message);
          return;
        }
        case 'error':
          /*
            Erro depois de aberto que não se resolve insistindo (`REMOVED`):
            marca `encerrado` ANTES do close que vem em seguida, senão o
            listener de close agenda reconexão e a pessoa tirada volta sozinha.
          */
          if (NAO_ADIANTA_INSISTIR.has(message.code)) {
            encerrado = true;
            saudacao = null;
          }
          return emitter.emit('closed', { reason: message.code });
        default:
          return;
      }
    });

    /**
     * Socket que fecha ou falha ANTES da resposta do servidor não diz nada
     * sobre haver transmissão — diz que não conseguimos falar com o servidor.
     *
     * Reportar `NOT_HOSTING` aqui foi um erro caro: um usuário no Brave via
     * "ninguém está transmitindo, aguardando" e ficava esperando por uma
     * transmissão que estava no ar. Todo bloqueio de navegador, proxy
     * corporativo ou queda de rede virava a mesma mensagem errada.
     */
    ws.addEventListener('close', () => {
      window.clearTimeout(timer);
      if (socket !== ws) return;
      failRefresh();
      if (!settled) {
        settled = true;
        aoFalhar({ code: 'SIGNAL_UNREACHABLE' });
        return;
      }
      if (opened && !closedByUs && !encerrado) {
        emitter.emit('closed', { reason: 'SIGNAL_CLOSED' });
        agendarReconexao();
      }
    });

    ws.addEventListener('error', () => {
      if (socket !== ws) return;
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      aoFalhar({ code: 'SIGNAL_UNREACHABLE' });
    });
  }

  function agendarReconexao(): void {
    if (closedByUs || saudacao === null || religar !== null) return;

    const base = Math.min(
      RECONECTAR_MAX_MS,
      RECONECTAR_MIN_MS * Math.pow(RECONECTAR_FATOR, tentativa),
    );
    /**
     * Jitter obrigatório: um deploy derruba TODOS os transmissores no mesmo
     * instante, e sem dispersão todos voltam no mesmo milissegundo e derrubam
     * o servidor que acabou de subir.
     */
    const espera = base * (0.5 + Math.random() * 0.5);
    tentativa += 1;

    religar = window.setTimeout(() => {
      religar = null;
      if (closedByUs || saudacao === null) return;
      conectar(
        saudacao,
        slugAtual,
        (aberto) => {
          tentativa = 0;
          emitter.emit('reopened', aberto);
        },
        (erro) => {
          if (NAO_ADIANTA_INSISTIR.has(erro.code)) {
            /**
             * Alguém assumiu o slug enquanto estávamos fora. Insistir só
             * esconderia isso do usuário.
             *
             * `encerrado` antes de emitir: o `ws.close()` do ramo de erro faz
             * o listener de close disparar em seguida com `opened = true`, e
             * um `SIGNAL_CLOSED` espúrio por cima apagava o motivo real —
             * a tela dizia "servidor fora do ar" para sempre em vez de
             * "você perdeu o slug".
             */
            saudacao = null;
            encerrado = true;
            emitter.emit('closed', { reason: erro.code });
            return;
          }
          agendarReconexao();
        },
      );
    }, espera);
  }

  return {
    host(slug, ownerToken, opcoes) {
      return new Promise<ChannelOpened>((resolve, reject) => {
        // `capacidade` vai na saudação, e a saudação é o que a reconexão
        // reenvia: o servidor que voltou recebe o mesmo número sem código novo.
        const hello: ClientMessage = {
          type: 'host', protocol: PROTOCOL_VERSION, slug, ownerToken,
          ...(opcoes?.capacidade === undefined ? {} : { capacidade: opcoes.capacidade }),
        };
        /**
         * Zerar aqui é obrigatório: `close()` marca `closedByUs` e nada mais
         * desmarcava. Um canal fechado uma vez ficava morto PARA SEMPRE — a
         * reconexão saía na primeira linha e o `closed` nunca era emitido. O
         * ciclo do StrictMode em desenvolvimento percorre exatamente esse
         * caminho (monta, encerra, remonta no mesmo canal), então o defeito
         * também deixava a reconexão inverificável.
         */
        closedByUs = false;
        encerrado = false;
        saudacao = hello;
        slugAtual = slug;
        tentativa = 0;
        conectar(hello, slug, resolve, (erro) => {
          // Falha na PRIMEIRA tentativa não agenda reconexão: quem decide o
          // que fazer é a sessão, que tem o polling e a máquina de estados.
          saudacao = null;
          reject(erro);
        });
      });
    },

    watch(slug, entrada) {
      return new Promise<ChannelOpened>((resolve, reject) => {
        const hello: ClientMessage = {
          type: 'watch', protocol: PROTOCOL_VERSION, slug,
          // Vazios não vão: sala aberta não pede nenhum dos dois (ADR 0028).
          ...(entrada.nome.trim() === '' ? {} : { name: entrada.nome }),
          ...(entrada.chave === '' ? {} : { viewerKey: entrada.chave }),
          ...(entrada.participantId === undefined ? {} : { participantId: entrada.participantId }),
          ...(entrada.attemptId === undefined ? {} : { attemptId: entrada.attemptId }),
        };
        closedByUs = false;
        encerrado = false;
        saudacao = hello;
        slugAtual = slug;
        tentativa = 0;
        conectar(hello, slug, resolve, (erro) => {
          saudacao = null;
          reject(erro);
        });
      });
    },

    refreshIce() {
      if (pendingRefresh !== null) return pendingRefresh.promise;
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject({ code: 'SIGNAL_UNREACHABLE' } satisfies SignalingError);
      }
      const requestId = crypto.randomUUID();
      let resolveRefresh!: (value: IceCredentials) => void;
      let rejectRefresh!: (reason: SignalingError) => void;
      const promise = new Promise<IceCredentials>((resolve, reject) => {
        resolveRefresh = resolve;
        rejectRefresh = reject;
      });
      const timer = window.setTimeout(failRefresh, HELLO_TIMEOUT_MS * 2);
      pendingRefresh = { requestId, promise, resolve: resolveRefresh, reject: rejectRefresh, timer };
      socket.send(JSON.stringify({ type: 'refresh-ice', requestId } satisfies ClientMessage));
      return promise;
    },

    removeViewers(peerId) {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      const message: ClientMessage =
        peerId === undefined ? { type: 'remove-viewers' } : { type: 'remove-viewers', peerId };
      socket.send(JSON.stringify(message));
    },

    responderPedido(peerId, aceitar) {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: aceitar ? 'admit' : 'deny', peerId } satisfies ClientMessage));
    },

    send(payload, to) {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      const message: ClientMessage =
        to === undefined
          ? { type: 'signal', payload }
          : { type: 'signal', to, payload };
      socket.send(JSON.stringify(message));
    },

    on(event, handler) {
      return emitter.on(event, handler);
    },

    close() {
      failRefresh();
      closedByUs = true;
      encerrado = true;
      saudacao = null;
      if (religar !== null) {
        window.clearTimeout(religar);
        religar = null;
      }
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'leave' } satisfies ClientMessage));
      }
      socket?.close();
      socket = null;
      emitter.clear();
    },
  };
}
