import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OWNER, SLUG, saudar } from './conformance.js';
import { ROTA_ESTADO, comMemoria, consultarPeloObjeto, lerEstadoPublico } from './estado-do-canal.js';
import { FakeDurableContext, FakeHibernatableSocket } from './testing-worker-driver.js';
import { ChannelRoom, type DurableObjectNamespace, type WebCryptoLike, makeChannelDeps } from './worker.js';

function sala() {
  const deps = makeChannelDeps({ CHANNELS: null as never, MAX_PEERS: '50' }, webcrypto as unknown as WebCryptoLike);
  const ctx = new FakeDurableContext();
  const ref = { room: new ChannelRoom(ctx, deps) };
  const abrir = () => {
    const socket = new FakeHibernatableSocket();
    socket.aoFechar = () => ref.room.handleClose(socket);
    ref.room.accept(socket);
    return socket;
  };
  const mandar = (socket: FakeHibernatableSocket, msg: unknown) =>
    ref.room.handleMessage(socket, SLUG, JSON.stringify(msg));
  const hibernar = () => { ref.room = new ChannelRoom(ctx, deps); };
  return { ref, abrir, mandar, hibernar };
}

describe('ChannelRoom.estadoPublico', () => {
  it('sem transmissor: fora do ar, ninguém assistindo', () => {
    expect(sala().ref.room.estadoPublico()).toEqual({ noAr: false, espectadores: 0 });
  });

  it('com transmissor e plateia: no ar, e o número sobrevive à hibernação', async () => {
    const s = sala();
    const host = s.abrir();
    await s.mandar(host, saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }, { capacidade: 50 }));
    expect(s.ref.room.estadoPublico()).toEqual({ noAr: true, espectadores: 0 });

    for (const id of ['a', 'b', 'c']) await s.mandar(s.abrir(), saudar({ type: 'watch', slug: SLUG }, {}, id));
    expect(s.ref.room.estadoPublico()).toEqual({ noAr: true, espectadores: 3 });

    s.hibernar();
    expect(s.ref.room.estadoPublico()).toEqual({ noAr: true, espectadores: 3 });
  });

  it('pedido esperando aprovação (ADR 0025) não conta como quem assiste', async () => {
    const s = sala();
    await s.mandar(s.abrir(), saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }, { approval: true }));
    await s.mandar(s.abrir(), saudar({ type: 'watch', slug: SLUG }, {}, 'esperando'));
    expect(s.ref.room.estadoPublico()).toEqual({ noAr: true, espectadores: 0 });
  });

  it('transmissor saiu: fora do ar', async () => {
    const s = sala();
    const host = s.abrir();
    await s.mandar(host, saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }));
    host.close();
    expect(s.ref.room.estadoPublico()).toEqual({ noAr: false, espectadores: 0 });
  });

  it('a resposta tem os dois campos e nada mais: sem IP, sem nome', async () => {
    const s = sala();
    await s.mandar(s.abrir(), saudar({ type: 'host', slug: SLUG, ownerToken: OWNER }));
    await s.mandar(s.abrir(), saudar({ type: 'watch', slug: SLUG }, {}, 'fulano'));
    expect(Object.keys(s.ref.room.estadoPublico()).sort()).toEqual(['espectadores', 'noAr']);
  });
});

describe('lerEstadoPublico', () => {
  it('aceita só o formato exato', () => {
    expect(lerEstadoPublico({ noAr: true, espectadores: 2 })).toEqual({ noAr: true, espectadores: 2 });
    expect(lerEstadoPublico({ noAr: 'sim', espectadores: 2 })).toBeNull();
    expect(lerEstadoPublico({ noAr: true, espectadores: -1 })).toBeNull();
    expect(lerEstadoPublico({ noAr: true, espectadores: 1.5 })).toBeNull();
    expect(lerEstadoPublico(null)).toBeNull();
  });
});

function namespace(responder: (slug: string, url: string) => Promise<Response>) {
  const nomes: string[] = [];
  const ns: DurableObjectNamespace = {
    idFromName: (nome) => {
      nomes.push(nome);
      return nome;
    },
    get: (id) => ({ fetch: (request) => responder(String(id), request.url) }),
  };
  return { ns, nomes };
}

describe('consultarPeloObjeto', () => {
  it('pergunta ao objeto DO SLUG, na rota interna', async () => {
    let rota = '';
    const { ns, nomes } = namespace(async (_slug, url) => {
      rota = new URL(url).pathname;
      return Response.json({ noAr: true, espectadores: 4 });
    });
    expect(await consultarPeloObjeto(ns)('jv')).toEqual({ noAr: true, espectadores: 4 });
    expect(nomes).toEqual(['jv']);
    expect(rota).toBe(ROTA_ESTADO);
  });

  it('erro, status ruim, JSON estranho ou prazo estourado: null, nunca lança', async () => {
    const lanca = namespace(async () => { throw new Error('objeto caiu'); });
    expect(await consultarPeloObjeto(lanca.ns)('jv')).toBeNull();

    const status = namespace(async () => new Response('x', { status: 500 }));
    expect(await consultarPeloObjeto(status.ns)('jv')).toBeNull();

    const estranho = namespace(async () => Response.json({ viewers: 3 }));
    expect(await consultarPeloObjeto(estranho.ns)('jv')).toBeNull();

    const lento = namespace(() => new Promise<Response>(() => undefined));
    expect(await consultarPeloObjeto(lento.ns, 10)('jv')).toBeNull();
  });
});

describe('comMemoria', () => {
  it('uma pergunta por slug dentro da validade; depois pergunta de novo', async () => {
    let agora = 0;
    const perguntas: string[] = [];
    const consultar = comMemoria(async (slug) => {
      perguntas.push(slug);
      return { noAr: true, espectadores: perguntas.length };
    }, () => agora, 30_000);

    expect(await consultar('jv')).toEqual({ noAr: true, espectadores: 1 });
    agora = 29_999;
    expect(await consultar('jv')).toEqual({ noAr: true, espectadores: 1 });
    expect(await consultar('outro')).toEqual({ noAr: true, espectadores: 2 });
    agora = 30_001;
    expect(await consultar('jv')).toEqual({ noAr: true, espectadores: 3 });
    expect(perguntas).toEqual(['jv', 'outro', 'jv']);
  });

  it('falha não é lembrada', async () => {
    let n = 0;
    const consultar = comMemoria(async () => (n++ === 0 ? null : { noAr: false, espectadores: 0 }), () => 0);
    expect(await consultar('jv')).toBeNull();
    expect(await consultar('jv')).toEqual({ noAr: false, espectadores: 0 });
  });
});
