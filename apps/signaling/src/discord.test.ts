import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lerConfigDoDiscord } from './discord-config.js';
import {
  LIMITE_DO_CORPO, type SubtleEd25519, assinaturaValida, atenderInteracao, slugDaOpcao,
} from './discord.js';
import type { EstadoPublico } from './worker.js';

const subtle = webcrypto.subtle as unknown as SubtleEd25519;
const AGORA_MS = 1_790_000_000_000;
const TS = String(Math.floor(AGORA_MS / 1000));
const ORIGEM = 'https://tela.example';

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('hex');

/** Um par Ed25519 novo por suíte: o app do Discord de mentira. */
async function app() {
  const par = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const publica = hex(await webcrypto.subtle.exportKey('raw', par.publicKey));
  const assinar = async (timestamp: string, corpo: string) =>
    hex(await webcrypto.subtle.sign({ name: 'Ed25519' }, par.privateKey, new TextEncoder().encode(timestamp + corpo)));
  return { publica, assinar };
}

type Estado = EstadoPublico | null;

async function cenario(estados: Record<string, Estado> = {}, opcoes: { applicationId?: string } = {}) {
  const { publica, assinar } = await app();
  const config = lerConfigDoDiscord({
    DISCORD_PUBLIC_KEY: publica,
    ...(opcoes.applicationId === undefined ? {} : { DISCORD_APPLICATION_ID: opcoes.applicationId }),
  });
  const consultas: string[] = [];
  const deps = {
    config,
    subtle,
    agora: () => AGORA_MS,
    consultar: async (slug: string) => {
      consultas.push(slug);
      return estados[slug] ?? null;
    },
  };
  const enviar = async (
    corpo: unknown,
    cabecalhos: { assinatura?: string | null; timestamp?: string | null } = {},
  ) => {
    const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    const timestamp = cabecalhos.timestamp === undefined ? TS : cabecalhos.timestamp;
    const assinatura = cabecalhos.assinatura === undefined
      ? await assinar(timestamp ?? '', texto)
      : cabecalhos.assinatura;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (assinatura !== null) headers['X-Signature-Ed25519'] = assinatura;
    if (timestamp !== null) headers['X-Signature-Timestamp'] = timestamp;
    return atenderInteracao(
      new Request(`${ORIGEM}/discord/interactions`, { method: 'POST', headers, body: texto }),
      deps,
    );
  };
  return { enviar, consultas, assinar, deps };
}

const comando = (canal?: string) => ({
  type: 2,
  application_id: '123456789012345678',
  data: {
    name: 'tela',
    ...(canal === undefined ? {} : { options: [{ name: 'canal', type: 3, value: canal }] }),
  },
});

type RespostaDeMensagem = {
  type: number;
  data: {
    content: string;
    flags: number;
    allowed_mentions: { parse: string[] };
    components?: { type: number; components: { type: number; style: number; label: string; url: string }[] }[];
  };
};

describe('assinatura (Ed25519)', () => {
  it('válida passa; o PING vira PONG', async () => {
    const c = await cenario();
    const resposta = await c.enviar({ type: 1 });
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ type: 1 });
  });

  it('assinatura de outro corpo: 401', async () => {
    const c = await cenario();
    const deOutro = await c.assinar(TS, JSON.stringify({ type: 2 }));
    expect((await c.enviar({ type: 1 }, { assinatura: deOutro })).status).toBe(401);
  });

  it('assinatura de outra chave: 401', async () => {
    const c = await cenario();
    const intruso = await app();
    const corpo = JSON.stringify({ type: 1 });
    expect((await c.enviar(corpo, { assinatura: await intruso.assinar(TS, corpo) })).status).toBe(401);
  });

  it('sem timestamp, sem assinatura ou lixo nos cabeçalhos: 401', async () => {
    const c = await cenario();
    expect((await c.enviar({ type: 1 }, { timestamp: null })).status).toBe(401);
    expect((await c.enviar({ type: 1 }, { assinatura: null })).status).toBe(401);
    expect((await c.enviar({ type: 1 }, { assinatura: 'zz' })).status).toBe(401);
  });

  it('timestamp velho, mesmo bem assinado: 401', async () => {
    const c = await cenario();
    const velho = String(Number(TS) - 3_600);
    expect((await c.enviar({ type: 1 }, { timestamp: velho })).status).toBe(401);
  });

  it('o verificador nunca lança', async () => {
    const chave = new Uint8Array(32);
    await expect(assinaturaValida(subtle, chave, 'ab'.repeat(64), TS, '{}', AGORA_MS)).resolves.toBe(false);
  });
});

describe('endpoint', () => {
  it('sem chave configurada: 404 (desligado)', async () => {
    const resposta = await atenderInteracao(
      new Request(`${ORIGEM}/discord/interactions`, { method: 'POST', body: '{}' }),
      { config: lerConfigDoDiscord({}), subtle, consultar: async () => null },
    );
    expect(resposta.status).toBe(404);
  });

  it('chave malformada também desliga, e só o código vai para o log', () => {
    const log: string[] = [];
    expect(lerConfigDoDiscord({ DISCORD_PUBLIC_KEY: 'segredo-errado' }, (p) => log.push(p))).toBeNull();
    expect(log).toEqual(['DISCORD_PUBLIC_KEY_INVALID']);
  });

  it('GET: 405', async () => {
    const c = await cenario();
    const resposta = await atenderInteracao(new Request(`${ORIGEM}/discord/interactions`), c.deps);
    expect(resposta.status).toBe(405);
  });

  it('corpo acima do teto: 413 antes de verificar qualquer coisa', async () => {
    const c = await cenario();
    const grande = JSON.stringify({ type: 1, lixo: 'x'.repeat(LIMITE_DO_CORPO) });
    expect((await c.enviar(grande)).status).toBe(413);
  });

  it('application_id diferente do configurado: recusado', async () => {
    const c = await cenario({}, { applicationId: '999999999999999999' });
    expect((await c.enviar(comando('joao'))).status).toBe(400);
  });
});

describe('/tela canal:<slug>', () => {
  it('canal no ar: mensagem pública com estado, link e botão ASSISTIR', async () => {
    const c = await cenario({ joao: { noAr: true, espectadores: 3 } });
    const resposta = await c.enviar(comando('joao'));
    const corpo = await resposta.json() as RespostaDeMensagem;

    expect(corpo.type).toBe(4);
    expect(corpo.data.content).toBe(`**joao** · AO VIVO agora · 3 assistindo\n${ORIGEM}/joao`);
    expect(corpo.data.flags & 64).toBe(0); // pública
    expect(corpo.data.allowed_mentions).toEqual({ parse: [] });
    expect(corpo.data.components?.[0]?.components[0]).toEqual({
      type: 2, style: 5, label: 'ASSISTIR', url: `${ORIGEM}/joao`,
    });
    expect(c.consultas).toEqual(['joao']);
  });

  it('canal fora do ar: diz que está fora, e o botão continua', async () => {
    const c = await cenario({ joao: { noAr: false, espectadores: 0 } });
    const corpo = await (await c.enviar(comando('joao'))).json() as RespostaDeMensagem;
    expect(corpo.data.content).toBe(`**joao** · fora do ar\n${ORIGEM}/joao`);
    expect(corpo.data.components?.[0]?.components[0]?.label).toBe('ASSISTIR');
  });

  it('estado indisponível: manda o link mesmo assim, sem afirmar nada', async () => {
    const c = await cenario();
    const corpo = await (await c.enviar(comando('joao'))).json() as RespostaDeMensagem;
    expect(corpo.data.content).toContain('não consegui ver');
    expect(corpo.data.content).toContain(`${ORIGEM}/joao`);
  });

  it('link inteiro colado na opção vale o mesmo que o nome', async () => {
    const c = await cenario({ joao: { noAr: true, espectadores: 0 } });
    const corpo = await (await c.enviar(comando(`${ORIGEM}/Joao/`))).json() as RespostaDeMensagem;
    expect(corpo.data.content).toBe(`**joao** · AO VIVO agora\n${ORIGEM}/joao`);
  });

  it('slug inválido ou reservado: resposta só para quem digitou, sem consultar', async () => {
    const c = await cenario();
    for (const ruim of ['jv', 'a b c', '-joao', 'transmitir', '@everyone']) {
      const corpo = await (await c.enviar(comando(ruim))).json() as RespostaDeMensagem;
      expect(corpo.type).toBe(4);
      expect(corpo.data.flags & 64).toBe(64);
      expect(corpo.data.content).not.toContain(ruim);
      expect(corpo.data.components).toBeUndefined();
    }
    expect(c.consultas).toEqual([]);
  });

  it('sem a opção: explica como usar, só para quem digitou', async () => {
    const c = await cenario();
    const corpo = await (await c.enviar(comando())).json() as RespostaDeMensagem;
    expect(corpo.data.flags & 64).toBe(64);
    expect(corpo.data.content).toContain('/tela canal:');
    expect(c.consultas).toEqual([]);
  });
});

describe('slugDaOpcao', () => {
  it('nome, link e lixo', () => {
    expect(slugDaOpcao('  joao ')).toBe('joao');
    expect(slugDaOpcao('https://tela.transmissao.workers.dev/joao')).toBe('joao');
    expect(slugDaOpcao('tela.transmissao.workers.dev/joao/')).toBe('joao');
    expect(slugDaOpcao('jv')).toBeNull();
    expect(slugDaOpcao('')).toBeNull();
  });
});
