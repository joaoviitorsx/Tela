// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SalaVagas, type Vaga } from './SalaVagas.js';

afterEach(() => cleanup());

function ocupadas(n: number): readonly Vaga[] {
  return Array.from({ length: n }, (_, i) => ({
    n: String(i + 1).padStart(2, '0'),
    nome: `AMIGO ${i + 1}`,
    estado: i % 4 === 3 ? 'VIA TURN' : 'ASSISTINDO',
    tom: i % 4 === 3 ? 'alerta' : 'ok',
  }));
}

const celulas = () =>
  Array.from(screen.getByTestId('mapa-da-sala').querySelectorAll('[data-tom]')).map((c) =>
    c.getAttribute('data-tom'),
  );

describe('SalaVagas', () => {
  it('sala pequena (3/5): uma célula e uma linha por vaga, as livres com número', () => {
    render(<SalaVagas vagas={ocupadas(3)} total={5} icone={null} />);

    expect(screen.getByText('3/5', { selector: 'summary span' })).toBeTruthy();
    expect(celulas()).toEqual(['ok', 'ok', 'ok', 'vazio', 'vazio']);

    const linhas = screen.getAllByRole('listitem');
    expect(linhas).toHaveLength(5);
    expect(within(linhas[3]!).getByText('04')).toBeTruthy();
    expect(within(linhas[3]!).getByText('vaga livre')).toBeTruthy();
    expect(screen.queryByText(/VAGAS LIVRES/)).toBeNull();
  });

  it('sala grande (12/50): 50 células, só quem está dentro na lista, livres numa linha', () => {
    render(<SalaVagas vagas={ocupadas(12)} total={50} icone={null} />);

    expect(screen.getByText('12/50', { selector: 'summary span' })).toBeTruthy();
    const mapa = celulas();
    expect(mapa).toHaveLength(50);
    expect(mapa.filter((t) => t !== 'vazio')).toHaveLength(12);
    // Quem passa por TURN acende diferente no mapa, como na lista.
    expect(mapa[3]).toBe('alerta');

    // 12 ocupadas + a linha-resumo das livres, e NÃO 50 linhas.
    expect(screen.getAllByRole('listitem')).toHaveLength(13);
    expect(screen.getByText('38 VAGAS LIVRES')).toBeTruthy();
    expect(screen.queryByText('vaga livre')).toBeNull();
    expect(screen.getByText('AMIGO 12')).toBeTruthy();
  });

  it('sala grande cheia (50/50): nenhuma linha de livres, e o singular quando sobra uma', () => {
    const { rerender } = render(<SalaVagas vagas={ocupadas(50)} total={50} icone={null} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.queryByText(/VAGAS? LIVRES?/)).toBeNull();

    rerender(<SalaVagas vagas={ocupadas(49)} total={50} icone={null} />);
    expect(screen.getByText('1 VAGA LIVRE')).toBeTruthy();
  });

  it('o resumo para leitor de tela diz ocupadas e total', () => {
    render(<SalaVagas vagas={ocupadas(2)} total={50} icone={null} />);
    expect(screen.getByLabelText('Sala: 2 de 50 vagas ocupadas. Ver quem está assistindo')).toBeTruthy();
  });
});
