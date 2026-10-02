// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelaDeQueda } from './TelaDeQueda.js';

afterEach(cleanup);

describe('TelaDeQueda', () => {
  it('diz que caiu, por quê, e que nada foi retomado', () => {
    render(<TelaDeQueda motivo="oom" aoVoltar={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'A TRANSMISSÃO CAIU' })).toBeTruthy();
    const alerta = screen.getByRole('alert').textContent ?? '';
    expect(alerta).toMatch(/sem memória/);
    expect(alerta).toMatch(/não foi retomada/);
    expect(document.body.textContent).toContain('MOTIVO: oom');
  });
  it('VOLTAR AO INÍCIO é o único caminho', () => {
    const aoVoltar = vi.fn();
    render(<TelaDeQueda motivo="crashed" aoVoltar={aoVoltar} />);
    fireEvent.click(screen.getByRole('button', { name: 'VOLTAR AO INÍCIO' }));
    expect(aoVoltar).toHaveBeenCalled();
  });
});
