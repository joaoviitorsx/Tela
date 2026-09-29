import { PROTOCOL_VERSION } from '@tela/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { OWNERSHIP_GRACE_MS, makeChannelRegistry } from './channel-registry.js';
import { DEFAULT_LIMITS } from './limits.js';
import { SpySocket, TestClock, testDeps } from './testing.js';

const SLUG = 'joao';
const OWNER = 'o'.repeat(43);
const OUTRO = 'z'.repeat(43);

describe('registro de canais', () => {
  let clock: TestClock;
  let registry: ReturnType<typeof makeChannelRegistry>;

  beforeEach(() => {
    clock = new TestClock();
    registry = makeChannelRegistry(testDeps(clock, { maxPeers: 3 }));
  });

  let hosts: { socket: SpySocket; conn: ReturnType<typeof registry.accept> }[] = [];
  let espectadores = 0;
  beforeEach(() => {
    hosts = [];
    espectadores = 0;
  });

  function host(slug = SLUG, ownerToken = OWNER, ip = '1.1.1.1') {
    const socket = new SpySocket();
    const conn = registry.accept(socket, ip);
    conn.receive(JSON.stringify({ type: 'host', slug, ownerToken, protocol: PROTOCOL_VERSION }));
    hosts.push({ socket, conn });
    return { socket, conn };
  }

  /** Entra e, como antes da aprovação manual (ADR 0025), é aceito na hora. */
  function watch(slug = SLUG, ip = '2.2.2.2') {
    const socket = new SpySocket();
    const conn = registry.accept(socket, ip);
    espectadores += 1;
    const name = `amigo${espectadores}`;
    conn.receive(JSON.stringify({
      type: 'watch', slug, protocol: PROTOCOL_VERSION,
      name, viewerKey: `k${name}`.padEnd(22, 'k'),
    }));
    if (socket.ofType('awaiting-approval').length > 0) {
      for (const h of [...hosts].reverse()) {
        const pedido = h.socket.ofType('join-request').find((m) => m.name === name);
        if (pedido === undefined || h.socket.closed) continue;
        h.conn.receive(JSON.stringify({ type: 'admit', peerId: pedido.peerId }));
        break;
      }
    }
    return { socket, conn };
  }

  describe('reivindicar canal', () => {
    it('transmissor recebe hosting com ICE e teto de peers', () => {
      const h = host();
      expect(h.socket.last()).toEqual({
        type: 'hosting',
        peerId: 'h_001',
        iceServers: [{ urls: ['stun:test'] }],
        relayStatus: 'not-configured',
        maxPeers: 3,
      });
    });

    it('recusa slug fora do formato', () => {
      const h = host('-x-');
      expect(h.socket.last()).toEqual({ type: 'error', code: 'SLUG_INVALID' });
      expect(h.socket.closed).toBe(true);
    });

    it('recusa outro dono no mesmo slug', () => {
      host();
      const intruso = host(SLUG, OUTRO, '9.9.9.9');
      expect(intruso.socket.last()).toEqual({ type: 'error', code: 'SLUG_TAKEN' });
    });

    it('o mesmo dono reconecta e derruba o socket antigo', () => {
      const primeiro = host();
      const segundo = host();
      expect(primeiro.socket.closed).toBe(true);
      expect(segundo.socket.last()).toMatchObject({ type: 'hosting' });
      expect(registry.channelCount).toBe(1);
    });

    it('o ownerToken nunca volta para o cliente', () => {
      const h = host();
      expect(JSON.stringify(h.socket.sent)).not.toContain(OWNER);
    });

    it('limita tentativas de host por IP', () => {
      for (let i = 0; i < DEFAULT_LIMITS.hostLimit; i += 1) host(`slug-${i}`, OWNER, '5.5.5.5');
      const excedente = host('slug-x', OWNER, '5.5.5.5');
      expect(excedente.socket.last()).toEqual({ type: 'error', code: 'RATE_LIMITED' });
    });

    it('o teto de host aguenta recarregar a página várias vezes', () => {
      // Atrás de CGNAT vários usuários dividem o mesmo IP, e cinco F5
      // trancavam a pessoa fora do próprio canal.
      for (let i = 0; i < 10; i += 1) {
        expect(host(SLUG, OWNER, '7.7.7.7').socket.last()).toMatchObject({ type: 'hosting' });
      }
    });
  });

  describe('entrar como espectador', () => {
    it('recusa quando ninguém transmite', () => {
      expect(watch().socket.last()).toEqual({ type: 'error', code: 'NOT_HOSTING' });
    });

    it('slug inexistente e slug offline devolvem o mesmo erro', () => {
      host();
      // canal existe mas o transmissor saiu
      const h = registry.accept(new SpySocket(), '1.1.1.1');
      h.disconnect();
      const a = watch('nunca-existiu');
      expect(a.socket.last()).toEqual({ type: 'error', code: 'NOT_HOSTING' });
    });

    it('recebe watching com o id do transmissor', () => {
      host();
      const v = watch();
      // `ofType` e não `last()`: depois do `watching` vem a contagem de
      // plateia, e prender o teste à ÚLTIMA mensagem o faz quebrar toda vez
      // que algo novo for anunciado na entrada.
      expect(v.socket.ofType('watching')).toEqual([
        {
          type: 'watching',
          peerId: 'v_002',
          hostId: 'h_001',
          iceServers: [{ urls: ['stun:test'] }],
          relayStatus: 'not-configured',
          viewers: 1,
        },
      ]);
    });

    it('avisa o transmissor da entrada', () => {
      const h = host();
      watch();
      expect(h.socket.ofType('peer-joined')).toEqual([
        { type: 'peer-joined', peerId: 'v_002', name: 'amigo1', fingerprint: expect.any(String) },
      ]);
    });

    it('aplica o teto de espectadores', () => {
      host();
      watch();
      watch();
      watch();
      expect(watch().socket.last()).toEqual({ type: 'error', code: 'CHANNEL_FULL' });
      expect(registry.viewerCount(SLUG)).toBe(3);
    });
  });

  describe('roteamento (R8: payload opaco)', () => {
    it('leva o payload do transmissor ao espectador endereçado, sem tocar nele', () => {
      const h = host();
      const v1 = watch();
      const v2 = watch();
      const payload = { qualquer: 'coisa', aninhado: [1, 2, { x: true }] };

      h.conn.receive(JSON.stringify({ type: 'signal', to: 'v_003', payload }));

      expect(v2.socket.ofType('signal')).toEqual([
        { type: 'signal', from: 'h_001', payload },
      ]);
      expect(v1.socket.ofType('signal')).toEqual([]);
    });

    it('espectador não precisa endereçar — vai sempre ao transmissor', () => {
      const h = host();
      const v = watch();
      v.conn.receive(JSON.stringify({ type: 'signal', payload: 'oi' }));
      expect(h.socket.ofType('signal')).toEqual([{ type: 'signal', from: 'v_002', payload: 'oi' }]);
    });

    it('espectador não alcança outro espectador', () => {
      host();
      const v1 = watch();
      const v2 = watch();
      v1.conn.receive(JSON.stringify({ type: 'signal', to: 'v_003', payload: 'malicioso' }));
      expect(v2.socket.ofType('signal')).toEqual([]);
    });

    it('sinal antes de host/watch é recusado', () => {
      const socket = new SpySocket();
      registry.accept(socket, '1.1.1.1').receive(JSON.stringify({ type: 'signal', payload: 1 }));
      expect(socket.last()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    });
  });

  describe('saídas e limpeza', () => {
    it('saída ANUNCIADA do transmissor derruba os espectadores', () => {
      const h = host();
      const v = watch();
      h.conn.receive(JSON.stringify({ type: 'leave' }));
      h.conn.disconnect();
      expect(v.socket.closed).toBe(true);
      expect(registry.isHosting(SLUG)).toBe(false);
    });

    /**
     * MUDANÇA DE COMPORTAMENTO deliberada, motivada por medição.
     *
     * O teste acima antes derrubava a plateia em QUALQUER fechamento de socket
     * do transmissor. A mídia é direta entre os dois — o servidor nunca esteve
     * no caminho dela — então uma piscada de rede do transmissor, ou um deploy
     * nosso, apagava transmissões que continuavam funcionando. Uma auditoria
     * mediu 5 segundos de tela morta e conexões duplicadas quando o transmissor
     * voltava com `peerId` novo e era admitido como se fosse outro peer.
     *
     * Quem detecta saída de verdade é o espectador, pela trilha remota que
     * termina. Este teste protege a promessa central da arquitetura.
     */
    it('QUEDA do socket do transmissor NÃO derruba os espectadores', () => {
      const h = host();
      const v = watch();
      h.conn.disconnect();

      expect(v.socket.closed).toBe(false);
      expect(v.socket.ofType('peer-left')).toEqual([]);
      // O canal continua existindo para o transmissor reivindicar de volta.
      expect(registry.viewerCount(SLUG)).toBe(1);
    });

    it('saída de espectador avisa o transmissor e libera a vaga', () => {
      const h = host();
      const v = watch();
      v.conn.disconnect();
      expect(h.socket.ofType('peer-left')).toEqual([{ type: 'peer-left', peerId: 'v_002' }]);
      expect(registry.viewerCount(SLUG)).toBe(0);
    });

    it('o dono mantém o slug durante a carência e o recupera', () => {
      const h = host();
      h.conn.disconnect();

      clock.advance(OWNERSHIP_GRACE_MS - 1_000);
      registry.sweep();
      // Um refresh de página não pode entregar o link para um estranho.
      expect(host(SLUG, OUTRO, '9.9.9.9').socket.last()).toEqual({
        type: 'error',
        code: 'SLUG_TAKEN',
      });
      expect(host().socket.last()).toMatchObject({ type: 'hosting' });
    });

    it('passada a carência, o slug fica livre', () => {
      host().conn.disconnect();
      clock.advance(OWNERSHIP_GRACE_MS + 1_000);
      registry.sweep();
      expect(registry.channelCount).toBe(0);
      expect(host(SLUG, OUTRO, '9.9.9.9').socket.last()).toMatchObject({ type: 'hosting' });
    });

    it('hello recusado não deixa canal fantasma', () => {
      // NOT_HOSTING é o caminho NORMAL de quem abre o link antes de o
      // transmissor conectar. Vazar um canal por tentativa faria o Map
      // crescer para sempre.
      for (let i = 0; i < 25; i += 1) {
        const v = watch(`canal-${i}`);
        v.conn.disconnect();
      }
      expect(registry.channelCount).toBe(0);
    });

    it('socket que não se apresenta é fechado', () => {
      const socket = new SpySocket();
      registry.accept(socket, '1.1.1.1');
      clock.advance(6_000);
      expect(socket.last()).toEqual({ type: 'error', code: 'HELLO_TIMEOUT' });
      expect(socket.closed).toBe(true);
    });

    it('conexão recusada não deixa timer disparando segundo erro', () => {
      const v = watch();
      expect(v.socket.sent).toEqual([{ type: 'error', code: 'NOT_HOSTING' }]);
      clock.advance(10_000);
      expect(v.socket.sent).toEqual([{ type: 'error', code: 'NOT_HOSTING' }]);
    });

    it('disconnect atrasado do socket antigo não destrói o canal do novo', () => {
      const primeiro = host();
      const segundo = host();
      // O evento close do socket derrubado chega DEPOIS da reconexão.
      primeiro.conn.disconnect();
      expect(registry.isHosting(SLUG)).toBe(true);
      expect(segundo.socket.closed).toBe(false);
    });
  });

  describe('mensagens inválidas', () => {
    it('JSON quebrado e schema inválido são recusados', () => {
      const a = new SpySocket();
      registry.accept(a, '1.1.1.1').receive('{{{');
      expect(a.last()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });

      const b = new SpySocket();
      registry.accept(b, '1.1.1.1').receive(JSON.stringify({ type: 'desconhecido' }));
      expect(b.last()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    });

    it('limita mensagens por conexão', () => {
      const h = host();
      for (let i = 0; i < DEFAULT_LIMITS.messageLimit + 10; i += 1) {
        h.conn.receive(JSON.stringify({ type: 'signal', to: 'v_x', payload: i }));
      }
      expect(h.socket.last()).toEqual({ type: 'error', code: 'RATE_LIMITED' });
    });

    it('aguenta três espectadores entrando ao mesmo tempo', () => {
      // O caso de uso CENTRAL: colar o link no Discord e três amigos clicarem.
      // A troca de ICE é em rajada — cada peer custa uma oferta mais um
      // candidato por vez, e em rede real são dezenas de candidatos.
      const h = host();
      for (let i = 0; i < 3; i += 1) watch(SLUG, `9.9.9.${i}`);

      // 3 peers × (1 oferta + ~40 candidatos) numa rajada.
      for (let peer = 0; peer < 3; peer += 1) {
        for (let msg = 0; msg < 41; msg += 1) {
          h.conn.receive(
            JSON.stringify({ type: 'signal', to: `v_00${peer + 2}`, payload: { candidate: msg } }),
          );
        }
      }

      // O transmissor NÃO pode ser derrubado no meio da negociação.
      expect(h.socket.ofType('error')).toEqual([]);
      expect(h.socket.closed).toBe(false);
    });

    it('a janela de mensagens reabre com o tempo', () => {
      const h = host();
      for (let i = 0; i < 25; i += 1) {
        h.conn.receive(JSON.stringify({ type: 'signal', to: 'v_x', payload: i }));
      }
      clock.advance(11_000);
      h.conn.receive(JSON.stringify({ type: 'signal', to: 'v_x', payload: 'ok' }));
      expect(h.socket.ofType('error')).toEqual([]);
    });

    it('leave fecha o socket', () => {
      const h = host();
      h.conn.receive(JSON.stringify({ type: 'leave' }));
      expect(h.socket.closed).toBe(true);
    });
  });
});

describe('convite (TELA-018)', () => {
  it('pedido sem resposta não gasta credencial TURN nem vaga', () => {
    const clock = new TestClock();
    const pedidos: string[] = [];
    const base = testDeps(clock, { maxPeers: 1 });
    const registry = makeChannelRegistry({
      ...base,
      iceServersFor: (peerId) => {
        pedidos.push(peerId);
        return base.iceServersFor(peerId);
      },
    });
    const hostSock = new SpySocket();
    registry.accept(hostSock, '1.1.1.1').receive(JSON.stringify({
      type: 'host', slug: SLUG, ownerToken: OWNER, protocol: PROTOCOL_VERSION,
    }));
    const antes = pedidos.length;
    const estranho = new SpySocket();
    registry.accept(estranho, '2.2.2.2').receive(JSON.stringify({
      type: 'watch', slug: SLUG, protocol: PROTOCOL_VERSION, name: 'eva', viewerKey: 'e'.repeat(22),
    }));
    expect(estranho.last()).toEqual({ type: 'awaiting-approval' });
    expect(pedidos.length).toBe(antes);
    expect(registry.viewerCount(SLUG)).toBe(0);
  });
});
