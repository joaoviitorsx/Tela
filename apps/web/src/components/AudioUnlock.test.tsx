// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioUnlock } from './AudioUnlock.js';

afterEach(cleanup);

describe('AudioUnlock', () => {
  it('V-09: escurece o jogo em 55%, não 70%, e o clique em qualquer ponto libera o som', () => {
    const aoLiberar = vi.fn();
    render(<AudioUnlock onUnlock={aoLiberar} />);
    const botao = screen.getByRole('button', { name: 'Ativar o som' });
    expect(botao.className).toContain('bg-black/55');
    expect(botao.className).not.toContain('bg-black/70');
    fireEvent.click(botao);
    expect(aoLiberar).toHaveBeenCalledTimes(1);
  });
});
