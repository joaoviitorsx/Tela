import { describe, expect, it, vi } from 'vitest';
import type { PortaReal } from './porta-nativa.js';
import { type ContextoDePcm, criarTrilhaDePcm, type NoDeWorklet } from './trilha-pcm.js';

function trilhaFalsa() {
  const ouvintes: Array<() => void> = [];
  const t = {
    stop: vi.fn(),
    dispatchEvent: vi.fn((e: Event) => {
      if (e.type === 'ended') ouvintes.forEach((o) => o());
      return true;
    }),
  };
  return t as unknown as MediaStreamTrack & typeof t;
}

function montar(opcoes: { transferirFalha?: boolean } = {}) {
  const mensagens: Array<{ m: unknown; transferir?: readonly unknown[] }> = [];
  const no: NoDeWorklet = {
    port: {
      postMessage: (m, transferir) => {
        if (opcoes.transferirFalha && transferir !== undefined) throw new Error('DataCloneError');
        mensagens.push({ m, ...(transferir === undefined ? {} : { transferir }) });
      },
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const trilha = trilhaFalsa();
  const fechado = { valor: false };
  const ctx: ContextoDePcm = {
    audioWorklet: { addModule: vi.fn(() => Promise.resolve()) },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => {
      fechado.valor = true;
      return Promise.resolve();
    }),
    criarNo: () => no,
    criarDestino: () => ({ trilha, no: 'destino' }),
  };
  const porta = { postMessage: vi.fn(), onmessage: null, close: vi.fn() } as unknown as PortaReal & { close: ReturnType<typeof vi.fn> };
  return { ctx, no, trilha, porta, mensagens, fechado };
}

describe('criarTrilhaDePcm', () => {
  it('carrega o worklet, liga ao destino e transfere a porta direto ao worklet', async () => {
    const { ctx, no, porta, mensagens } = montar();
    await criarTrilhaDePcm(porta, { criarContexto: () => ctx, urlDoWorklet: '/pcm-worklet.js' });
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith('/pcm-worklet.js');
    expect(no.connect).toHaveBeenCalledWith('destino');
    expect(ctx.resume).toHaveBeenCalled();
    expect(mensagens[0]).toEqual({ m: { tipo: 'porta', porta }, transferir: [porta] });
  });

  it('se a porta não pode ir ao worklet, a thread principal repassa os blocos válidos', async () => {
    const { ctx, porta, mensagens } = montar({ transferirFalha: true });
    await criarTrilhaDePcm(porta, { criarContexto: () => ctx, urlDoWorklet: 'x' });
    expect(porta.onmessage).not.toBeNull();
    const dados = new Float32Array(960);
    porta.onmessage?.({ data: { t: 'pcm', n: 1, dados } });
    porta.onmessage?.({ data: { t: 'lixo' } });
    expect(mensagens).toEqual([{ m: { tipo: 'pcm', dados } }]);
  });

  it('parar a trilha fecha a porta, desliga o nó e fecha o contexto', async () => {
    const { ctx, no, porta, trilha, fechado } = montar();
    const r = await criarTrilhaDePcm(porta, { criarContexto: () => ctx, urlDoWorklet: 'x' });
    r.trilha.stop();
    expect(porta.close).toHaveBeenCalledTimes(1);
    expect(no.disconnect).toHaveBeenCalledTimes(1);
    expect(fechado.valor).toBe(true);
    // Parar de novo não fecha duas vezes.
    r.trilha.stop();
    expect(no.disconnect).toHaveBeenCalledTimes(1);
    expect(trilha.stop).toBeDefined();
  });

  it('encerrar (o jogo fechou) para a trilha e dispara `ended` uma vez', async () => {
    const { ctx, porta, trilha } = montar();
    const r = await criarTrilhaDePcm(porta, { criarContexto: () => ctx, urlDoWorklet: 'x' });
    r.encerrar();
    r.encerrar();
    const fins = trilha.dispatchEvent.mock.calls.filter(([e]) => (e as Event).type === 'ended');
    expect(fins).toHaveLength(1);
  });
});
