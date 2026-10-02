// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeletorDeResolucao } from './SeletorDeResolucao.js';

afterEach(cleanup);

const linha = (id: string) => ({
  ref: () => undefined,
  tabIndex: -1 as const,
  'data-linha': id,
  onFocus: () => undefined,
});

function montar() {
  return render(
    <SeletorDeResolucao
      opcoes={[
        { id: 'a', rotulo: '1080p60', largura: 1920, altura: 1080, fps: 60, mbps: '12,0' },
        { id: 'b', rotulo: '720p60', largura: 1280, altura: 720, fps: 60, mbps: '6,0' },
      ]}
      escolhido="a"
      sustentavel={null}
      ajuda="ajuda"
      aoEscolher={vi.fn()}
      propsGrupo={linha('resolucao')}
      quadros={[
        { id: 'fluidez', fps: 60, nome: 'FLUIDEZ' },
        { id: 'nitidez', fps: 30, nome: 'NITIDEZ' },
      ]}
      quadrosEscolhido="fluidez"
      aoEscolherQuadros={vi.fn()}
      propsQuadros={linha('quadros')}
    />,
  );
}

describe('SeletorDeResolucao', () => {
  it('B-09: os dois grupos dizem ao leitor de tela como navegar entre as linhas', () => {
    montar();
    const dica = document.getElementById('dica-menu-osd');
    expect(dica?.textContent).toMatch(/setas para cima e para baixo/);
    for (const nome of ['Resolução', 'Quadros por segundo']) {
      const grupo = screen.getByRole('radiogroup', { name: nome });
      expect(grupo.getAttribute('aria-describedby')).toContain('dica-menu-osd');
    }
  });

  it('W-03: a opção não marcada tem contorno de 3:1 sobre o fundo (edge-key, não line)', () => {
    montar();
    const nao = screen.getByRole('radio', { name: /720p60/ });
    expect(nao.className).toContain('border-edge-key');
    expect(nao.className).not.toContain('border-line');
  });
});
