// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MolduraDesktop } from './MolduraDesktop.js';
import type { ModoDaJanelaStore } from './modo-da-janela.js';
import { criarSessaoAoVivo } from './sessao-ao-vivo.js';
import { estadoVivo, par, sessaoFalsa } from './testes-de-sessao.js';

afterEach(cleanup);

function modoFalso(inicial: 'normal' | 'compacto') {
  let atual = inicial;
  const ouvintes = new Set<() => void>();
  const store: ModoDaJanelaStore = {
    atual: () => atual,
    assinar: (o) => {
      ouvintes.add(o);
      return () => ouvintes.delete(o);
    },
    pedir: vi.fn(),
  };
  return {
    store,
    mudar: (m: 'normal' | 'compacto') => {
      atual = m;
      ouvintes.forEach((o) => o());
    },
  };
}

function Filho({ aoMontar, aoDesmontar }: { aoMontar: () => void; aoDesmontar: () => void }) {
  // Efeito com cleanup: o que desmontar a rota de transmissão derrubaria.
  return (
    <div
      ref={(el) => {
        if (el !== null) aoMontar();
        return () => aoDesmontar();
      }}
    >
      rota de transmissão
    </div>
  );
}

function cenario(modo: 'normal' | 'compacto') {
  const fonte = criarSessaoAoVivo();
  const s = sessaoFalsa(estadoVivo({ peers: [par('a', 'connected')] }));
  fonte.registrar(s.sessao);
  const m = modoFalso(modo);
  const aoMontar = vi.fn();
  const aoDesmontar = vi.fn();
  render(
    <MolduraDesktop sessao={fonte} modo={m.store}>
      <Filho aoMontar={aoMontar} aoDesmontar={aoDesmontar} />
    </MolduraDesktop>,
  );
  return { s, m, aoMontar, aoDesmontar };
}

describe('MolduraDesktop — painel NO AR e modo compacto', () => {
  it('ao vivo, o painel aparece no pé; ENCERRAR pergunta porque há quem assista', () => {
    const { s } = cenario('normal');
    const painel = screen.getByRole('region', { name: 'Transmissão no ar' });
    expect(painel.textContent).toContain('1/50');
    fireEvent.click(screen.getByRole('button', { name: 'ENCERRAR' }));
    expect(s.stop).not.toHaveBeenCalled();
    // A confirmação é o diálogo do Tela (o mesmo da rota), aberto.
    expect(document.querySelector('dialog[open]')?.textContent).toContain('ENCERRAR A TRANSMISSÃO?');
  });

  it('fora do ar não há painel', () => {
    const fonte = criarSessaoAoVivo();
    fonte.registrar(sessaoFalsa().sessao);
    render(<MolduraDesktop sessao={fonte}><span>home</span></MolduraDesktop>);
    expect(screen.queryByRole('region', { name: 'Transmissão no ar' })).toBeNull();
  });

  it('compacto: a faixa substitui o painel e a rota CONTINUA MONTADA, só escondida', () => {
    const { aoDesmontar } = cenario('compacto');
    expect(screen.getByRole('region', { name: /janela compacta/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Transmissão no ar' })).toBeNull();
    expect(screen.getByText('rota de transmissão').closest('.hidden')).not.toBeNull();
    expect(aoDesmontar).not.toHaveBeenCalled();
  });

  it('alternar normal ↔ compacto não desmonta a rota (a sessão viveria nela)', () => {
    const { m, aoDesmontar } = cenario('normal');
    act(() => m.mudar('compacto'));
    act(() => m.mudar('normal'));
    expect(aoDesmontar).not.toHaveBeenCalled();
  });

  it('compacto: ENCERRAR pergunta inline, sem diálogo modal', () => {
    cenario('compacto');
    fireEvent.click(screen.getByRole('button', { name: 'ENCERRAR' }));
    expect(screen.getByRole('group', { name: 'Confirmar encerramento' })).toBeTruthy();
    expect(document.querySelector('dialog[open]')).toBeNull();
  });

  it('EXPANDIR pede o modo normal ao main', () => {
    const { m } = cenario('compacto');
    fireEvent.click(screen.getByRole('button', { name: 'EXPANDIR' }));
    expect(m.store.pedir).toHaveBeenCalledWith('normal');
  });
});
