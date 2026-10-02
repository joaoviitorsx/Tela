// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from './Home.js';

// `define` do Vite; em vitest ninguém o injeta (container.ts lê `__TELA_VERSION__`).
vi.hoisted(() => {
  Object.assign(globalThis, { __TELA_VERSION__: null });
});

beforeEach(() => {
  window.localStorage.clear();
  // happy-dom não tem `getDisplayMedia`: a home mostraria só o aviso do celular (B-06).
  // Movimento reduzido: o passo troca na hora, sem o chiado de 260 ms entre eles.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({
      matches: true,
      media,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: vi.fn() },
  });
});
afterEach(cleanup);

const campo = (): HTMLInputElement => document.getElementById('slug') as HTMLInputElement;

describe('Home — passo 1', () => {
  it('H-02: TRANSMITIR com o campo vazio responde: foca o campo e diz o que falta', () => {
    const { container } = render(<Home onStart={vi.fn()} />);
    const botao = screen.getByRole('button', { name: /TRANSMITIR/ });
    expect((botao as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(botao);

    expect(document.activeElement).toBe(campo());
    expect(container.querySelector('#slug-status')?.textContent).toMatch(/Digite um nome para o canal/);
    expect(campo().getAttribute('aria-invalid')).toBe('true');
  });

  it('H-02: o aviso some quando a pessoa digita', () => {
    const { container } = render(<Home onStart={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /TRANSMITIR/ }));
    fireEvent.change(campo(), { target: { value: 'joao' } });
    expect(container.querySelector('#slug-status')?.textContent).not.toMatch(/Digite um nome/);
  });

  it('H-02: Enter no campo vazio também responde', () => {
    const { container } = render(<Home onStart={vi.fn()} />);
    fireEvent.keyDown(campo(), { key: 'Enter' });
    expect(container.querySelector('#slug-status')?.textContent).toMatch(/Digite um nome/);
  });

  it('H-03: nome vindo da última visita ganha o rótulo, e perde ao editar', () => {
    window.localStorage.setItem('tela.slug', 'joao');
    render(<Home onStart={vi.fn()} />);
    // A chave real vem de `identity`; se ela não leu, o teste abaixo falha com clareza.
    expect(campo().value).toBe('joao');
    expect(screen.getByText('ÚLTIMO CANAL · TROQUE SE QUISER')).toBeTruthy();
    fireEvent.change(campo(), { target: { value: 'joao2' } });
    expect(screen.queryByText('ÚLTIMO CANAL · TROQUE SE QUISER')).toBeNull();
  });

  it('H-03: primeira visita não tem o rótulo', () => {
    render(<Home onStart={vi.fn()} />);
    expect(screen.queryByText(/ÚLTIMO CANAL/)).toBeNull();
  });

  it('B-04: uma frase por regra quebrada', () => {
    const { container } = render(<Home onStart={vi.fn()} />);
    const frase = () => container.querySelector('#slug-status')?.textContent ?? '';
    fireEvent.change(campo(), { target: { value: 'ab' } });
    expect(frase()).toMatch(/Falta 1 caractere \(mínimo 3\)/);
    fireEvent.change(campo(), { target: { value: '-abc' } });
    expect(frase()).toMatch(/Não pode começar com hífen/);
    fireEvent.change(campo(), { target: { value: 'abc-' } });
    expect(frase()).toMatch(/Não pode terminar com hífen/);
    fireEvent.change(campo(), { target: { value: 'ab c' } });
    expect(frase()).toMatch(/Só letras, números e hífen/);
  });

  it('B-04: inválido mantém a borda de erro mesmo com foco', () => {
    const { container } = render(<Home onStart={vi.fn()} />);
    fireEvent.change(campo(), { target: { value: 'ab' } });
    const moldura = container.querySelector('[data-vidro="contorno"]');
    expect(moldura?.className).toContain('border-danger-edge');
    expect(moldura?.className).not.toContain('focus-within:border-accent');
  });

  it('B-08: os passos dizem o que se decide e o 3 avisa da próxima janela', () => {
    render(<Home onStart={vi.fn()} />);
    fireEvent.change(campo(), { target: { value: 'joao' } });
    fireEvent.click(screen.getByRole('button', { name: /TRANSMITIR/ }));
    expect(screen.getAllByText('IMAGEM').length).toBeGreaterThan(0);
    expect(screen.queryByText(/TELA OU JOGO/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /CONTINUAR/ }));
    expect(screen.getByText(/PRÓXIMA JANELA/)).toBeTruthy();
    expect(screen.getAllByText('SOM').length).toBeGreaterThan(0);
  });

  it('D-04: no site o cabeçalho com DIAGNÓSTICO continua na página', () => {
    render(<Home onStart={vi.fn()} />);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('button', { name: /DIAGNÓSTICO/i })).toBeTruthy();
  });
});
