// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarraDaJanela } from './BarraDaJanela.js';
import { MolduraDesktop } from './MolduraDesktop.js';
import type { EstadoDaJanela, PonteDesktop } from './ponte.js';
import { useBarraDaJanela } from './use-barra-da-janela.js';

afterEach(cleanup);

const aoes = () => ({ aoMinimizar: vi.fn(), aoAlternarMaximizar: vi.fn(), aoFechar: vi.fn() });

describe('BarraDaJanela', () => {
  it('Linux: três botões com rótulo, cada um chama o seu pedido', () => {
    const a = aoes();
    render(<BarraDaJanela plataforma="linux" link="tela.gg/jv" ativa maximizada={false} compacto={false} {...a} />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximizar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(a.aoMinimizar).toHaveBeenCalledTimes(1);
    expect(a.aoAlternarMaximizar).toHaveBeenCalledTimes(1);
    expect(a.aoFechar).toHaveBeenCalledTimes(1);
    expect(screen.getByText('tela.gg/jv')).toBeTruthy();
  });

  it('maximizada: o botão vira Restaurar', () => {
    render(<BarraDaJanela plataforma="linux" link={null} ativa maximizada compacto={false} {...aoes()} />);
    expect(screen.getByRole('button', { name: 'Restaurar' })).toBeTruthy();
  });

  it('compacto: sem maximizar', () => {
    render(<BarraDaJanela plataforma="linux" link={null} ativa maximizada={false} compacto {...aoes()} />);
    expect(screen.queryByRole('button', { name: /maximizar|restaurar/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Fechar' })).toBeTruthy();
  });

  it('Windows: nenhum botão nosso (o overlay é do sistema)', () => {
    render(<BarraDaJanela plataforma="win32" link={null} ativa maximizada={false} compacto={false} {...aoes()} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Barra da janela' })).toBeTruthy();
  });

  it('sem foco a barra marca data-ativa=false', () => {
    render(<BarraDaJanela plataforma="linux" link={null} ativa={false} maximizada={false} compacto={false} {...aoes()} />);
    expect(screen.getByRole('group', { name: 'Barra da janela' }).getAttribute('data-ativa')).toBe('false');
  });
});

function janelaFalsa() {
  let ouvinte: ((e: EstadoDaJanela) => void) | null = null;
  const janela: PonteDesktop['janela'] = {
    minimizar: vi.fn(),
    alternarMaximizar: vi.fn(),
    fechar: vi.fn(),
    aoMudarEstado: (o) => {
      ouvinte = o;
      return () => {
        ouvinte = null;
      };
    },
  };
  return { janela, emitir: (e: EstadoDaJanela) => act(() => ouvinte?.(e)) };
}

describe('useBarraDaJanela', () => {
  it('sem ponte e no macOS não há barra', () => {
    expect(renderHook(() => useBarraDaJanela(undefined)).result.current).toBeNull();
    const { janela } = janelaFalsa();
    expect(renderHook(() => useBarraDaJanela({ plataforma: 'darwin', janela })).result.current).toBeNull();
  });

  it('acompanha o estado do main e repassa os pedidos', () => {
    const f = janelaFalsa();
    const { result } = renderHook(() => useBarraDaJanela({ plataforma: 'linux', janela: f.janela }));
    expect(result.current?.estado.focada).toBe(true);
    f.emitir({ focada: false, maximizada: true, telaCheia: false });
    expect(result.current?.estado).toEqual({ focada: false, maximizada: true, telaCheia: false });
    result.current?.fechar();
    expect(f.janela.fechar).toHaveBeenCalledTimes(1);
  });
});

describe('MolduraDesktop com a barra', () => {
  function moldura(f: ReturnType<typeof janelaFalsa>) {
    // Só o que a moldura lê da ponte neste teste.
    const sem = () => () => undefined;
    const ponte = {
      plataforma: 'linux' as const,
      janela: f.janela,
      versao: 'teste',
      aoAbrirCanal: sem,
      aoMudarModo: sem,
      aoMudarVisibilidade: sem,
      aoPerguntarFechar: sem,
      aoPedirEncerrar: sem,
      aoPedirParar: sem,
      aoMudarAtualizacao: sem,
      enviarEstadoAoVivo: () => undefined,
      pedirModo: () => undefined,
      responderFechar: () => undefined,
      paradaConcluida: () => undefined,
      abrirNoNavegador: () => undefined,
      verificarAtualizacao: () => undefined,
      reiniciarEAtualizar: () => undefined,
      ajustes: () => new Promise<never>(() => undefined),
      salvarAjustes: () => new Promise<never>(() => undefined),
      atualizacao: () => Promise.resolve(null),
    };
    return render(
      <MolduraDesktop ponte={ponte}>
        <span>home</span>
      </MolduraDesktop>,
    );
  }

  it('aparece com a ponte e some em tela cheia', () => {
    const f = janelaFalsa();
    moldura(f);
    expect(screen.getByRole('group', { name: 'Barra da janela' })).toBeTruthy();
    f.emitir({ focada: true, maximizada: false, telaCheia: true });
    expect(screen.queryByRole('group', { name: 'Barra da janela' })).toBeNull();
  });
});
