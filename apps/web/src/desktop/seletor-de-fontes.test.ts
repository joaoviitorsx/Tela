import { describe, expect, it, vi } from 'vitest';
import type { FonteDeCaptura } from './ponte.js';
import { makeSeletorDeFontes } from './seletor-de-fontes.js';

const TELA: FonteDeCaptura = { id: 'screen:0:0', nome: 'TELA INTEIRA', tipo: 'tela', miniatura: null, icone: null };
const JOGO: FonteDeCaptura = { id: 'window:7:0', nome: 'Hades II', tipo: 'janela', miniatura: 'data:,x', icone: null };

function montar(
  listagens: Array<readonly FonteDeCaptura[] | Error> = [[TELA, JOGO]],
  avisoAntesDeEscolher?: (fonte: FonteDeCaptura) => string | null,
) {
  const timers: Array<{ fn: () => void; cancelado: boolean }> = [];
  let chamadas = 0;
  const listar = vi.fn(async () => {
    const r = listagens[Math.min(chamadas, listagens.length - 1)];
    chamadas += 1;
    if (r instanceof Error) throw r;
    return r ?? [];
  });
  const seletor = makeSeletorDeFontes({
    listar,
    agendar: (fn) => {
      const t = { fn, cancelado: false };
      timers.push(t);
      return () => {
        t.cancelado = true;
      };
    },
    intervaloMs: 2000,
    ...(avisoAntesDeEscolher === undefined ? {} : { avisoAntesDeEscolher }),
  });
  const mudancas = vi.fn();
  seletor.assinar(mudancas);
  const disparar = () => {
    const t = timers.find((x) => !x.cancelado);
    if (t === undefined) throw new Error('nenhum timer pendente');
    t.cancelado = true;
    t.fn();
  };
  return { seletor, listar, timers, mudancas, disparar };
}

const tique = () => new Promise((r) => setTimeout(r, 0));

describe('makeSeletorDeFontes', () => {
  it('nasce fechado, na aba de telas, sem fontes', () => {
    const { seletor } = montar();
    expect(seletor.snapshot()).toEqual({ aberto: false, aba: 'telas', fontes: [], carregando: false, confirmacao: null });
  });

  it('abrir lista, mostra, e escolher resolve com a fonte e fecha', async () => {
    const { seletor, listar, mudancas } = montar();
    const promessa = seletor.abrir();
    expect(seletor.snapshot()).toMatchObject({ aberto: true, carregando: true, fontes: [] });
    await tique();
    expect(listar).toHaveBeenCalledTimes(1);
    expect(seletor.snapshot()).toMatchObject({ aberto: true, carregando: false, fontes: [TELA, JOGO] });

    seletor.escolher('window:7:0');
    expect(await promessa).toEqual(JOGO);
    expect(seletor.snapshot()).toMatchObject({ aberto: false, fontes: [] });
    expect(mudancas).toHaveBeenCalled();
  });

  it('cancelar resolve com null e para de listar', async () => {
    const { seletor, listar, timers } = montar();
    const promessa = seletor.abrir();
    await tique();
    expect(timers.filter((t) => !t.cancelado)).toHaveLength(1);
    seletor.cancelar();
    expect(await promessa).toBeNull();
    expect(timers.every((t) => t.cancelado)).toBe(true);
    expect(listar).toHaveBeenCalledTimes(1);
  });

  it('com o seletor aberto a listagem se repete no intervalo; fechado, não', async () => {
    const { seletor, listar, disparar } = montar([[TELA], [TELA, JOGO]]);
    void seletor.abrir();
    await tique();
    expect(seletor.snapshot().fontes).toEqual([TELA]);
    disparar();
    await tique();
    expect(listar).toHaveBeenCalledTimes(2);
    expect(seletor.snapshot().fontes).toEqual([TELA, JOGO]);
    seletor.cancelar();
    expect(() => disparar()).toThrow();
  });

  it('listagem que falha mantém a anterior e continua tentando', async () => {
    const { seletor, disparar } = montar([[TELA], new Error('ipc'), [JOGO]]);
    void seletor.abrir();
    await tique();
    disparar();
    await tique();
    expect(seletor.snapshot().fontes).toEqual([TELA]);
    disparar();
    await tique();
    expect(seletor.snapshot().fontes).toEqual([JOGO]);
  });

  it('uma listagem atrasada de uma abertura anterior não entra', async () => {
    let soltar: ((f: readonly FonteDeCaptura[]) => void) | null = null;
    const seletor = makeSeletorDeFontes({
      listar: () =>
        new Promise((r) => {
          soltar = r;
        }),
      agendar: () => () => undefined,
    });
    const primeira = seletor.abrir();
    const soltarPrimeira = soltar!;
    seletor.cancelar();
    expect(await primeira).toBeNull();
    const segunda = seletor.abrir();
    soltarPrimeira([JOGO]);
    await tique();
    expect(seletor.snapshot()).toMatchObject({ aberto: true, carregando: true, fontes: [] });
    soltar!([TELA]);
    await tique();
    expect(seletor.snapshot().fontes).toEqual([TELA]);
    seletor.cancelar();
    expect(await segunda).toBeNull();
  });

  it('escolher o que não está na lista não faz nada; abrir por cima desiste do anterior', async () => {
    const { seletor } = montar();
    const primeira = seletor.abrir();
    await tique();
    seletor.escolher('window:999:0');
    expect(seletor.snapshot().aberto).toBe(true);
    const segunda = seletor.abrir();
    expect(await primeira).toBeNull();
    await tique();
    seletor.escolher('screen:0:0');
    expect(await segunda).toEqual(TELA);
  });

  it('a aba sobrevive ao fechar: quem escolheu janela da última vez volta nela', async () => {
    const { seletor } = montar();
    void seletor.abrir();
    seletor.mudarAba('janelas');
    seletor.cancelar();
    expect(seletor.snapshot().aba).toBe('janelas');
    const assinante = vi.fn();
    seletor.assinar(assinante);
    seletor.mudarAba('janelas');
    expect(assinante).not.toHaveBeenCalled();
  });
});

describe('makeSeletorDeFontes — aviso antes de escolher (cursor do LoL)', () => {
  const LOL: FonteDeCaptura = { id: 'window:9:0', nome: 'League of Legends (TM) Client', tipo: 'janela', miniatura: null, icone: null };
  const aviso = (f: FonteDeCaptura) => (f.id === LOL.id ? 'o cursor some' : null);

  it('escolher a fonte com aviso NÃO fecha: pede confirmação', async () => {
    const { seletor } = montar([[TELA, JOGO, LOL]], aviso);
    let escolhida: FonteDeCaptura | null | undefined;
    void seletor.abrir().then((f) => {
      escolhida = f;
    });
    await tique();
    seletor.escolher(LOL.id);
    await tique();
    expect(escolhida).toBeUndefined();
    expect(seletor.snapshot().confirmacao).toEqual({ fonte: LOL, aviso: 'o cursor some' });
  });

  it('confirmar vale a fonte pendente', async () => {
    const { seletor } = montar([[TELA, JOGO, LOL]], aviso);
    const promessa = seletor.abrir();
    await tique();
    seletor.escolher(LOL.id);
    seletor.confirmar();
    await expect(promessa).resolves.toEqual(LOL);
    expect(seletor.snapshot().confirmacao).toBeNull();
  });

  it('trocar por tela desiste da janela, vai para TELAS e continua aberto', async () => {
    const { seletor } = montar([[TELA, JOGO, LOL]], aviso);
    void seletor.abrir();
    await tique();
    seletor.mudarAba('janelas');
    seletor.escolher(LOL.id);
    seletor.trocarPorTela();
    expect(seletor.snapshot()).toMatchObject({ aberto: true, aba: 'telas', confirmacao: null });
    seletor.escolher(TELA.id);
    expect(seletor.snapshot().aberto).toBe(false);
  });

  it('fonte sem aviso escolhe direto; reabrir zera a confirmação', async () => {
    const { seletor } = montar([[TELA, JOGO, LOL]], aviso);
    const p1 = seletor.abrir();
    await tique();
    seletor.escolher(JOGO.id);
    await expect(p1).resolves.toEqual(JOGO);
    void seletor.abrir();
    await tique();
    seletor.escolher(LOL.id);
    void seletor.abrir();
    expect(seletor.snapshot().confirmacao).toBeNull();
  });
});
