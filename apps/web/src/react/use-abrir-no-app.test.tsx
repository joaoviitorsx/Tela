// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AmbienteDoNavegador, ResultadoDaTentativa } from '../core/domain/abrir-no-app.js';
import type { AbrirNoApp, MarcaSemApp } from '../core/ports/abrir-no-app.js';
import { useAbrirNoApp } from './use-abrir-no-app.js';

afterEach(cleanup);

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function montar(opcoes: { ambiente?: Partial<AmbienteDoNavegador>; semApp?: boolean } = {}) {
  let resolver: (r: ResultadoDaTentativa) => void = () => undefined;
  const tentar = vi.fn(
    () =>
      new Promise<ResultadoDaTentativa>((r) => {
        resolver = r;
      }),
  );
  const abrirNoApp: AbrirNoApp = {
    ambiente: () => ({
      userAgent: CHROME_WIN,
      plataforma: null,
      dentroDoApp: false,
      paginaEmFoco: true,
      automatizado: false,
      ...opcoes.ambiente,
    }),
    tentar,
  };
  let guardada = opcoes.semApp ?? false;
  const marca: MarcaSemApp = {
    ler: () => guardada,
    gravar: vi.fn(() => {
      guardada = true;
    }),
    limpar: vi.fn(() => {
      guardada = false;
    }),
  };
  return { abrirNoApp, marca, tentar, resolver: (r: ResultadoDaTentativa) => resolver(r) };
}

describe('useAbrirNoApp', () => {
  it('onde há o que tentar: nasce "tentando", e sem resposta vira navegador e grava a marca', async () => {
    const m = montar();
    const { result } = renderHook(() => useAbrirNoApp('joao', m.abrirNoApp, m.marca));
    expect(result.current.fase).toBe('tentando');
    expect(m.tentar).toHaveBeenCalledWith('joao');

    await act(async () => m.resolver('nao-abriu'));
    expect(result.current.fase).toBe('navegador');
    expect(m.marca.gravar).toHaveBeenCalledOnce();
  });

  it('com o app respondendo: "no-app", sem gravar a marca', async () => {
    const m = montar();
    const { result } = renderHook(() => useAbrirNoApp('joao', m.abrirNoApp, m.marca));
    await act(async () => m.resolver('abriu'));
    expect(result.current.fase).toBe('no-app');
    expect(m.marca.gravar).not.toHaveBeenCalled();
  });

  it('só UMA tentativa, mesmo no StrictMode (monta duas vezes)', () => {
    const m = montar();
    const embrulho = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => useAbrirNoApp('joao', m.abrirNoApp, m.marca), { wrapper: embrulho });
    expect(m.tentar).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['dentro do app', { dentroDoApp: true }, false],
    ['celular', { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36' }, false],
    ['Safari', { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/18 Safari/605' }, false],
    ['sem foco', { paginaEmFoco: false }, true],
    ['navegador automatizado', { automatizado: true }, true],
  ] as const)('%s: a fase já nasce "navegador", sem esperar nada', (_nome, ambiente, _oferece) => {
    const m = montar({ ambiente });
    const { result } = renderHook(() => useAbrirNoApp('joao', m.abrirNoApp, m.marca));
    expect(result.current.fase).toBe('navegador');
    expect(m.tentar).not.toHaveBeenCalled();
  });

  it('aparelho já marcado "sem app": nem tenta, mas o botão manual continua oferecido', () => {
    const m = montar({ semApp: true });
    const { result } = renderHook(() => useAbrirNoApp('joao', m.abrirNoApp, m.marca));
    expect(result.current.fase).toBe('navegador');
    expect(result.current.oferece).toBe(true);
    expect(m.tentar).not.toHaveBeenCalled();
  });

  it('o botão não existe no app nem no celular', () => {
    const noApp = montar({ ambiente: { dentroDoApp: true } });
    expect(renderHook(() => useAbrirNoApp('joao', noApp.abrirNoApp, noApp.marca)).result.current.oferece).toBe(false);
  });

  it('ABRIR NO APP: limpa a marca; se abrir, o viewer da web sai de cena', async () => {
    const m = montar({ semApp: true });
    const { result } = renderHook(() => useAbrirNoApp('joao', m.abrirNoApp, m.marca));
    act(() => result.current.abrir());
    expect(m.marca.limpar).toHaveBeenCalledOnce();
    expect(result.current.manual).toBe('tentando');
    // O viewer segue no navegador durante a tentativa manual.
    expect(result.current.fase).toBe('navegador');

    await act(async () => m.resolver('abriu'));
    expect(result.current.fase).toBe('no-app');
    expect(result.current.manual).toBe('ocioso');
  });

  it('ABRIR NO APP sem o app: avisa que falhou, segue no navegador e volta a marcar', async () => {
    const m = montar({ semApp: true });
    const { result } = renderHook(() => useAbrirNoApp('joao', m.abrirNoApp, m.marca));
    act(() => result.current.abrir());
    await act(async () => m.resolver('nao-abriu'));
    expect(result.current.manual).toBe('falhou');
    expect(result.current.fase).toBe('navegador');
    expect(m.marca.gravar).toHaveBeenCalled();
  });

  it('CONTINUAR NO NAVEGADOR: conecta aqui e lembra a escolha', async () => {
    const m = montar();
    const { result } = renderHook(() => useAbrirNoApp('joao', m.abrirNoApp, m.marca));
    await act(async () => m.resolver('abriu'));
    act(() => result.current.continuarNoNavegador());
    expect(result.current.fase).toBe('navegador');
    expect(m.marca.gravar).toHaveBeenCalled();
  });

  it('resposta que chega depois de desmontar não mexe em nada', async () => {
    const m = montar();
    const { unmount } = renderHook(() => useAbrirNoApp('joao', m.abrirNoApp, m.marca));
    unmount();
    await act(async () => m.resolver('nao-abriu'));
    expect(m.marca.gravar).not.toHaveBeenCalled();
  });
});
