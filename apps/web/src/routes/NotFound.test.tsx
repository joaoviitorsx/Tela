// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { __TELA_VERSION__: null });
});

import { NotFound } from './NotFound.js';

afterEach(cleanup);

describe('NotFound', () => {
  it('R-03: primeiro a ação (conferir o endereço, ir ao início); as regras do nome vêm depois', () => {
    const aoInicio = vi.fn();
    const { container } = render(<NotFound onHome={aoInicio} />);
    const texto = container.textContent ?? '';
    expect(texto).toMatch(/Confira o endereço que te mandaram/);
    expect(texto.indexOf('Confira o endereço')).toBeLessThan(texto.indexOf('3 a 25 caracteres'));
    expect(texto).not.toMatch(/forma de um link/);
    fireEvent.click(screen.getByRole('button', { name: 'IR PARA O INÍCIO' }));
    expect(aoInicio).toHaveBeenCalledTimes(1);
  });
});
