// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Container from '../container.js';

vi.hoisted(() => {
  Object.assign(globalThis, { __TELA_VERSION__: null });
});

// Dentro do app o container desktop diz `dentroDoApp = true` (D-04).
vi.mock('../container.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Container>()),
  dentroDoApp: true,
  ofereceApp: false,
}));

import { Home } from './Home.js';

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn() } });
});
afterEach(cleanup);

describe('Home dentro do app (D-04)', () => {
  it('sem cabeçalho do site: nem a marca, nem DIAGNÓSTICO, nem o link do código (o trilho tem os três)', () => {
    render(<Home onStart={vi.fn()} />);
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('button', { name: /DIAGNÓSTICO/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Código do canal/i })).toBeNull();
    // O conteúdo da página segue lá.
    expect(document.getElementById('slug')).not.toBeNull();
  });
});
