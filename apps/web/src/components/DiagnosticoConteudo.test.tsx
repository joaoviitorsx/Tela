// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticoConteudo } from './DiagnosticoConteudo.js';

afterEach(cleanup);

function montar(tom: 'ok' | 'alerta' | 'neutro', texto: string) {
  render(
    <DiagnosticoConteudo
      veredito={{ tom, texto }}
      resumo={[{ rotulo: 'DENSIDADE', valor: '0,107' }]}
      espectadores={[]}
      audio={{ texto: 'Som saindo normalmente.', tom: 'ok' }}
      copiado={false}
      aoCopiar={vi.fn()}
    />,
  );
}

describe('DiagnosticoConteudo', () => {
  it('o veredito vem primeiro, em português, e é anunciado', () => {
    montar('ok', 'Tudo certo: 1 amigo recebendo 1280×720.');
    expect(screen.getByRole('status').textContent).toMatch(/Tudo certo/);
  });

  it('a grade técnica fica atrás de VER DETALHES, fechada', () => {
    montar('ok', 'Tudo certo.');
    const detalhes = document.querySelector('details') as HTMLDetailsElement;
    expect(detalhes.open).toBe(false);
    expect(detalhes.querySelector('summary')?.textContent).toMatch(/VER DETALHES/);
    expect(detalhes.textContent).toContain('DENSIDADE');
    // O jargão não está fora dos detalhes.
    const fora = (document.querySelector('[data-testid="veredito"]')?.textContent ?? '');
    expect(fora).not.toContain('DENSIDADE');
  });

  it('alerta usa a moldura de aviso', () => {
    montar('alerta', '! Sua subida não sustenta esta qualidade.');
    expect(screen.getByRole('status').className).toContain('border-warn-edge');
  });
});
