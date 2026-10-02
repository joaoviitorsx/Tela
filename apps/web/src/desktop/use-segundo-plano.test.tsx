// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotivoDeParada } from './ponte.js';
import { criarSessaoAoVivo } from './sessao-ao-vivo.js';
import { estadoVivo, par, sessaoFalsa } from './testes-de-sessao.js';
import { AVISO_DE_SUSPENSAO, type PonteDoSegundoPlano, useSegundoPlano, useTempo } from './use-segundo-plano.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function ponteFalsa() {
  const ouvintes: {
    encerrar: Array<() => void>;
    parar: Array<(m: MotivoDeParada) => void>;
    perguntar: Array<() => void>;
    ocultar: Array<() => void>;
    atalho: Array<(ativo: boolean) => void>;
  } = { encerrar: [], parar: [], perguntar: [], ocultar: [], atalho: [] };
  const ponte: PonteDoSegundoPlano & { readonly espiao: Record<string, ReturnType<typeof vi.fn>> } = {
    enviarEstadoAoVivo: vi.fn(),
    responderFechar: vi.fn(),
    paradaConcluida: vi.fn(),
    aoPedirEncerrar: vi.fn((o: () => void) => {
      ouvintes.encerrar.push(o);
      return () => undefined;
    }),
    aoPedirParar: vi.fn((o: (m: MotivoDeParada) => void) => {
      ouvintes.parar.push(o);
      return () => undefined;
    }),
    aoPerguntarFechar: vi.fn((o: () => void) => {
      ouvintes.perguntar.push(o);
      return () => undefined;
    }),
    aoAlternarOculto: vi.fn((o: () => void) => {
      ouvintes.ocultar.push(o);
      return () => undefined;
    }),
    aoAtalhoOculto: vi.fn((o: (ativo: boolean) => void) => {
      ouvintes.atalho.push(o);
      return () => undefined;
    }),
    espiao: {},
  };
  return { ponte, ouvintes };
}

function montar() {
  const fonte = criarSessaoAoVivo();
  const s = sessaoFalsa();
  fonte.registrar(s.sessao);
  const { ponte, ouvintes } = ponteFalsa();
  const somDeOculto = vi.fn();
  const hook = renderHook(() => useSegundoPlano({ sessao: fonte, ponte, somDeOculto }));
  return { fonte, s, ponte, ouvintes, hook, somDeOculto };
}

describe('useSegundoPlano', () => {
  it('fora do ar: nada de painel, e nada de IPC (o main já começa em "fora do ar")', () => {
    const { hook, ponte } = montar();
    expect(hook.result.current.noAr).toBe(false);
    expect(ponte.enviarEstadoAoVivo).not.toHaveBeenCalled();
  });

  it('ao ir ao ar o main recebe o estado; mudanças em rajada saem a ≤ 1 Hz', () => {
    const { hook, s, ponte } = montar();
    vi.setSystemTime(10_000);
    act(() => s.mudar(estadoVivo({ peers: [par('a', 'connected')] })));
    expect(hook.result.current.noAr).toBe(true);
    expect(hook.result.current.painel).toMatchObject({ assistindo: 1, capacidade: 50, link: 'tela.gg/jv', rota: 'direta' });
    expect(ponte.enviarEstadoAoVivo).toHaveBeenLastCalledWith({
      noAr: true,
      inicioMs: 10_000,
      assistindo: 1,
      capacidade: 50,
      link: 'https://tela.gg/jv',
      oculto: false,
    });
    const antes = vi.mocked(ponte.enviarEstadoAoVivo).mock.calls.length;

    act(() => s.mudar(estadoVivo({ peers: [par('a', 'connected'), par('b', 'connected')] })));
    act(() => s.mudar(estadoVivo({ peers: [par('a', 'connected'), par('b', 'connected'), par('c', 'connected')] })));
    expect(vi.mocked(ponte.enviarEstadoAoVivo).mock.calls.length).toBe(antes);
    act(() => void vi.advanceTimersByTime(1100));
    expect(vi.mocked(ponte.enviarEstadoAoVivo).mock.calls.length).toBe(antes + 1);
    expect(ponte.enviarEstadoAoVivo).toHaveBeenLastCalledWith(expect.objectContaining({ assistindo: 3 }));
  });

  it('"parar" do main: stop() da sessão e SÓ ENTÃO confirma', async () => {
    const { s, ouvintes, ponte } = montar();
    act(() => s.mudar(estadoVivo()));
    await act(async () => {
      ouvintes.parar[0]?.('sair');
      await Promise.resolve();
    });
    expect(s.stop).toHaveBeenCalledWith('USER_STOPPED');
    expect(ponte.paradaConcluida).toHaveBeenCalledTimes(1);
  });

  it('parar por suspensão deixa o motivo explícito para quem volta', async () => {
    const { hook, s, ouvintes } = montar();
    act(() => s.mudar(estadoVivo()));
    await act(async () => {
      ouvintes.parar[0]?.('suspensao');
      await Promise.resolve();
    });
    expect(hook.result.current.aviso).toBe(AVISO_DE_SUSPENSAO);
    expect(AVISO_DE_SUSPENSAO).toBe('A transmissão foi encerrada porque o computador entrou em suspensão.');
    act(() => hook.result.current.dispensarAviso());
    expect(hook.result.current.aviso).toBeNull();
  });

  it('parar sem transmissão ainda confirma ao main (ele não pode esperar à toa)', async () => {
    const { ouvintes, ponte } = montar();
    await act(async () => {
      ouvintes.parar[0]?.('sair');
      await Promise.resolve();
    });
    expect(ponte.paradaConcluida).toHaveBeenCalledTimes(1);
  });

  it('"Encerrar" da bandeja roda o fluxo da interface: com gente assistindo, pede confirmação', () => {
    const { hook, s, ouvintes } = montar();
    act(() => s.mudar(estadoVivo({ peers: [par('a', 'connected')] })));
    act(() => ouvintes.encerrar[0]?.());
    expect(hook.result.current.encerrar.confirmando).toBe(true);
    expect(s.stop).not.toHaveBeenCalled();
    act(() => hook.result.current.encerrar.confirmar());
    expect(s.stop).toHaveBeenCalledWith('USER_STOPPED');
  });

  it('"Encerrar" da bandeja sem plateia encerra direto', () => {
    const { s, ouvintes } = montar();
    act(() => s.mudar(estadoVivo()));
    act(() => ouvintes.encerrar[0]?.());
    expect(s.stop).toHaveBeenCalled();
  });

  it('fechar ao vivo: pergunta, e a resposta vai ao main com o "lembrar"', () => {
    const { hook, ouvintes, ponte } = montar();
    act(() => ouvintes.perguntar[0]?.());
    expect(hook.result.current.fechar.perguntando).toBe(true);
    act(() => hook.result.current.fechar.mudarLembrar(true));
    act(() => hook.result.current.fechar.responder('segundo-plano'));
    expect(ponte.responderFechar).toHaveBeenCalledWith({ acao: 'segundo-plano', lembrar: true });
    expect(hook.result.current.fechar.perguntando).toBe(false);
  });

  it('cancelar nunca é lembrado, mesmo com a caixa marcada', () => {
    const { hook, ouvintes, ponte } = montar();
    act(() => ouvintes.perguntar[0]?.());
    act(() => hook.result.current.fechar.mudarLembrar(true));
    act(() => hook.result.current.fechar.responder('cancelar'));
    expect(ponte.responderFechar).toHaveBeenCalledWith({ acao: 'cancelar', lembrar: false });
  });

  it('compactar pede ao main; sem ponte, não há compacto', () => {
    const fonte = criarSessaoAoVivo();
    const modo = { atual: () => 'normal' as const, assinar: () => () => undefined, pedir: vi.fn() };
    const { ponte } = ponteFalsa();
    const comModo = renderHook(() => useSegundoPlano({ sessao: fonte, ponte, modo }));
    act(() => comModo.result.current.compactar?.());
    expect(modo.pedir).toHaveBeenCalledWith('compacto');
    const semPonte = renderHook(() => useSegundoPlano({ sessao: criarSessaoAoVivo(), ponte: undefined }));
    expect(semPonte.result.current.compactar).toBeNull();
  });
});

describe('useTempo', () => {
  it('anda a cada segundo enquanto ativo e para quando não', () => {
    vi.setSystemTime(100_000);
    const { result, rerender } = renderHook(({ ativo }) => useTempo(100_000, ativo), { initialProps: { ativo: true } });
    expect(result.current).toBe('00:00');
    act(() => void vi.advanceTimersByTime(3000));
    expect(result.current).toBe('00:03');
    rerender({ ativo: false });
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current).toBe('00:03');
  });

  it('atalho de privacidade: oculta sem som, mostra de novo, e confirma com som', async () => {
    const { s, ouvintes, somDeOculto, hook } = montar();
    act(() => s.mudar(estadoVivo()));
    await act(async () => {
      ouvintes.ocultar[0]?.();
      await Promise.resolve();
    });
    expect(s.pausar).toHaveBeenCalledWith({ manterSom: false });
    expect(somDeOculto).toHaveBeenLastCalledWith(true);
    expect(hook.result.current.painel.oculto).toBe(true);
    await act(async () => {
      ouvintes.ocultar[0]?.();
      await Promise.resolve();
    });
    expect(s.retomar).toHaveBeenCalledTimes(1);
    expect(somDeOculto).toHaveBeenLastCalledWith(false);
  });

  it('atalho fora do ar não faz nada', async () => {
    const { s, ouvintes, somDeOculto } = montar();
    await act(async () => {
      ouvintes.ocultar[0]?.();
      await Promise.resolve();
    });
    expect(s.pausar).not.toHaveBeenCalled();
    expect(somDeOculto).not.toHaveBeenCalled();
  });

  it('o painel só promete o atalho quando o main o registrou', () => {
    const { s, ouvintes, hook } = montar();
    act(() => s.mudar(estadoVivo()));
    expect(hook.result.current.painel.atalhoOculto).toBeNull();
    act(() => ouvintes.atalho[0]?.(true));
    expect(hook.result.current.painel.atalhoOculto).toBe('CTRL+SHIFT+O');
  });
});
