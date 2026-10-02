// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '../core/domain/result.js';
import type { CaptureRequest, ScreenCapture } from '../core/ports/screen-capture.js';
import { makeCapturaDesktop } from './captura-desktop.js';
import type { CapacidadesDesktop, FimDaCapturaNativa, FonteDeCaptura, RespostaDeCapturaNativa } from './ponte.js';
import type { PortaReal } from './porta-nativa.js';

const PEDIDO: CaptureRequest = { width: 1920, height: 1080, frameRate: 60, systemAudio: true };
const TELA: FonteDeCaptura = { id: 'screen:0:0', nome: 'TELA INTEIRA', tipo: 'tela', miniatura: null, icone: null };
const JOGO: FonteDeCaptura = { id: 'window:7:0', nome: 'Hades II', tipo: 'janela', miniatura: null, icone: null };

/** `MediaStreamTrack` não existe no happy-dom: o fantasma é um EventTarget com `stop`. */
function trilhaFalsa(rotulo: string): MediaStreamTrack {
  const t = new EventTarget() as EventTarget & { stop: () => void; parada: boolean; rotulo: string };
  t.rotulo = rotulo;
  t.parada = false;
  t.stop = () => {
    t.parada = true;
  };
  return t as unknown as MediaStreamTrack;
}

function montar(opcoes: {
  capacidades?: Partial<CapacidadesDesktop> | 'falha';
  respostas?: RespostaDeCapturaNativa[];
  escolha?: FonteDeCaptura | null;
  aceita?: boolean;
  navegador?: Awaited<ReturnType<ScreenCapture['request']>>;
}) {
  const capacidades: CapacidadesDesktop = { nvenc: false, nvencDetalhe: 'x', seletorProprio: false, ...(typeof opcoes.capacidades === 'object' ? opcoes.capacidades : {}) };
  const respostas = [...(opcoes.respostas ?? [])];
  let aoEncerrar: ((fim: FimDaCapturaNativa) => void) | null = null;
  const parar = vi.fn();
  const escolherFonte = vi.fn(async () => opcoes.aceita ?? true);
  const iniciar = vi.fn(async () => respostas.shift() ?? ({ ok: false, erro: 'MORREU' } as const));
  const abrir = vi.fn(async () => opcoes.escolha ?? null);
  const trilhaReal = trilhaFalsa('real');
  const navegador: ScreenCapture = {
    isSupported: () => true,
    request: vi.fn(async () => opcoes.navegador ?? ok({ video: trilhaReal, audio: null, surface: 'desconhecido' as const })),
  };
  const portas = new Map<number, PortaReal>();
  const ligar = vi.fn();
  const desligar = vi.fn();
  let fantasmas = 0;
  const captura = makeCapturaDesktop({
    ponte: {
      capacidades: opcoes.capacidades === 'falha' ? () => Promise.reject(new Error('ipc')) : async () => capacidades,
      escolherFonte,
      capturaNativa: {
        iniciar,
        parar,
        aoEncerrar: (o) => {
          aoEncerrar = o;
          return () => undefined;
        },
      },
    },
    seletor: { abrir },
    navegador,
    ligacao: {
      aguardar: async (id) => {
        const p: PortaReal = { postMessage: () => undefined, onmessage: null, close: () => undefined };
        portas.set(id, p);
        return p;
      },
      ligar,
      desligar,
    },
    criarTrilhaFantasma: () => trilhaFalsa(`fantasma${fantasmas++}`),
  });
  return { captura, iniciar, parar, escolherFonte, abrir, navegador, ligar, desligar, portas, trilhaReal, encerrar: (f: FimDaCapturaNativa) => aoEncerrar?.(f) };
}

const PRONTO = { ok: true, id: 1, fonte: { width: 2560, height: 1600 }, memoria: 'dmabuf' } as const;

describe('makeCapturaDesktop — caminho nativo', () => {
  it('sobe o processo com o pedido, liga a porta e entrega a fantasma', async () => {
    const m = montar({ capacidades: { nvenc: true }, respostas: [PRONTO] });
    const r = await m.captura.request(PEDIDO);
    expect(m.iniciar).toHaveBeenCalledWith({ width: 1920, height: 1080, fps: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.audio).toBeNull();
    expect(r.value.surface).toBe('desconhecido');
    expect(m.captura.ehNativa(r.value.video)).toBe(true);
    expect(m.captura.ehNativa(m.trilhaReal)).toBe(false);
    expect(m.ligar).toHaveBeenCalledWith(1, m.portas.get(1));
    expect(m.navegador.request).not.toHaveBeenCalled();
  });

  it('parar a fantasma para o processo e desliga a porta, uma vez só', async () => {
    const m = montar({ capacidades: { nvenc: true }, respostas: [PRONTO] });
    const r = await m.captura.request(PEDIDO);
    if (!r.ok) throw new Error();
    r.value.video.stop();
    r.value.video.stop();
    expect(m.parar).toHaveBeenCalledTimes(1);
    expect(m.parar).toHaveBeenCalledWith(1);
    expect(m.desligar).toHaveBeenCalledWith(1);
    expect((r.value.video as unknown as { parada: boolean }).parada).toBe(true);
    // Depois de parada, o fim do processo não encerra nada.
    const ended = vi.fn();
    r.value.video.addEventListener('ended', ended);
    m.encerrar({ id: 1, motivo: 'MORREU', codigo: null });
    expect(ended).not.toHaveBeenCalled();
  });

  it('o processo morrer encerra a fantasma como uma trilha real: `ended`', async () => {
    const m = montar({ capacidades: { nvenc: true }, respostas: [PRONTO] });
    const r = await m.captura.request(PEDIDO);
    if (!r.ok) throw new Error();
    const ended = vi.fn();
    r.value.video.addEventListener('ended', ended);
    m.encerrar({ id: 99, motivo: 'FONTE_ENCERRADA', codigo: 4 }); // outra sessão: nada
    expect(ended).not.toHaveBeenCalled();
    m.encerrar({ id: 1, motivo: 'FONTE_ENCERRADA', codigo: 4 });
    expect(ended).toHaveBeenCalledTimes(1);
    expect((r.value.video as unknown as { parada: boolean }).parada).toBe(true);
    expect(m.desligar).toHaveBeenCalledWith(1);
    // A sessão vai chamar `stop()` na trilha encerrada: não manda `parar` a um morto.
    r.value.video.stop();
    expect(m.parar).not.toHaveBeenCalled();
  });

  it('cancelar o portal é DENIED, e o nativo continua valendo', async () => {
    const m = montar({ capacidades: { nvenc: true }, respostas: [{ ok: false, erro: 'CANCELADO' }, PRONTO] });
    expect(await m.captura.request(PEDIDO)).toEqual(err('DENIED'));
    expect(m.captura.motivoDoFallback()).toBeNull();
    expect((await m.captura.request(PEDIDO)).ok).toBe(true);
    expect(m.iniciar).toHaveBeenCalledTimes(2);
  });

  it('OCUPADO é FAILED, sem abandonar o nativo', async () => {
    const m = montar({ capacidades: { nvenc: true }, respostas: [{ ok: false, erro: 'OCUPADO' }] });
    expect(await m.captura.request(PEDIDO)).toEqual(err('FAILED'));
    expect(m.captura.motivoDoFallback()).toBeNull();
  });

  it('falha de componente cai no getDisplayMedia em silêncio e não tenta de novo', async () => {
    const m = montar({ capacidades: { nvenc: true }, respostas: [{ ok: false, erro: 'SEM_COMPONENTE' }, PRONTO] });
    const r = await m.captura.request(PEDIDO);
    expect(r.ok && r.value.video).toBe(m.trilhaReal);
    expect(m.captura.motivoDoFallback()).toBe('SEM_COMPONENTE');
    await m.captura.request(PEDIDO);
    expect(m.iniciar).toHaveBeenCalledTimes(1);
    expect(m.navegador.request).toHaveBeenCalledTimes(2);
  });

  it('trocar de fonte: a nova sessão ganha outra fantasma, e parar a antiga não desliga a nova', async () => {
    const m = montar({ capacidades: { nvenc: true }, respostas: [PRONTO, { ...PRONTO, id: 2 }] });
    const a = await m.captura.request(PEDIDO);
    const b = await m.captura.request(PEDIDO);
    if (!a.ok || !b.ok) throw new Error();
    expect(a.value.video).not.toBe(b.value.video);
    expect(m.ligar).toHaveBeenLastCalledWith(2, m.portas.get(2));
    a.value.video.stop();
    expect(m.parar).toHaveBeenCalledWith(1);
    expect(m.desligar).toHaveBeenCalledWith(1);
    expect(m.desligar).not.toHaveBeenCalledWith(2);
  });
});

describe('makeCapturaDesktop — seletor próprio', () => {
  it('escolher uma janela: avisa o main, captura, e a superfície é a escolha', async () => {
    const m = montar({ capacidades: { seletorProprio: true }, escolha: JOGO });
    const r = await m.captura.request(PEDIDO);
    expect(m.abrir).toHaveBeenCalledTimes(1);
    expect(m.escolherFonte).toHaveBeenCalledWith('window:7:0');
    expect(m.navegador.request).toHaveBeenCalledWith(PEDIDO);
    expect(r).toEqual(ok({ video: m.trilhaReal, audio: null, surface: 'window' }));
    expect(m.captura.ehNativa(m.trilhaReal)).toBe(false);
  });

  it('escolher uma tela: superfície monitor', async () => {
    const m = montar({ capacidades: { seletorProprio: true }, escolha: TELA });
    const r = await m.captura.request(PEDIDO);
    expect(r.ok && r.value.surface).toBe('monitor');
  });

  it('cancelar o seletor: avisa o main (nada pendente) e é DENIED, sem getDisplayMedia', async () => {
    const m = montar({ capacidades: { seletorProprio: true }, escolha: null });
    expect(await m.captura.request(PEDIDO)).toEqual(err('DENIED'));
    expect(m.escolherFonte).toHaveBeenCalledWith(null);
    expect(m.navegador.request).not.toHaveBeenCalled();
  });

  it('o main recusar a escolha é FAILED', async () => {
    const m = montar({ capacidades: { seletorProprio: true }, escolha: TELA, aceita: false });
    expect(await m.captura.request(PEDIDO)).toEqual(err('FAILED'));
    expect(m.navegador.request).not.toHaveBeenCalled();
  });

  it('o erro do getDisplayMedia passa como veio', async () => {
    const m = montar({ capacidades: { seletorProprio: true }, escolha: TELA, navegador: err('FAILED') });
    expect(await m.captura.request(PEDIDO)).toEqual(err('FAILED'));
  });
});

describe('makeCapturaDesktop — portal do sistema', () => {
  it('sem nvenc e sem seletor próprio é o getDisplayMedia de sempre', async () => {
    const m = montar({});
    const r = await m.captura.request(PEDIDO);
    expect(m.abrir).not.toHaveBeenCalled();
    expect(m.iniciar).not.toHaveBeenCalled();
    expect(r.ok && r.value.video).toBe(m.trilhaReal);
  });

  it('a ponte falhar em capacidades vale como nenhuma capacidade, e pergunta uma vez só', async () => {
    const m = montar({ capacidades: 'falha' });
    await m.captura.request(PEDIDO);
    await m.captura.request(PEDIDO);
    expect(m.navegador.request).toHaveBeenCalledTimes(2);
  });
});
