// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbertoNoApp } from './AbertoNoApp.js';

afterEach(cleanup);

describe('AbertoNoApp', () => {
  it('aberto: diz ABERTO NO APP, o canal, e que não há segunda vaga', () => {
    render(<AbertoNoApp slug="joao" estado="aberto" aoContinuarNoNavegador={() => undefined} />);
    expect(screen.getByText('ABERTO NO APP')).toBeTruthy();
    expect(screen.getByText('joao')).toBeTruthy();
    expect(screen.getByText(/não ocupa duas vagas|não ocupa duas|duas vagas/i)).toBeTruthy();
  });
  it('tentando: avisa que a transmissão continua aqui se o app não abrir', () => {
    render(<AbertoNoApp slug="joao" estado="tentando" aoContinuarNoNavegador={() => undefined} />);
    expect(screen.getByText('ABRINDO NO APP…')).toBeTruthy();
  });
  it('CONTINUAR NO NAVEGADOR dispara o callback', () => {
    const aoContinuar = vi.fn();
    render(<AbertoNoApp slug="joao" estado="aberto" aoContinuarNoNavegador={aoContinuar} />);
    fireEvent.click(screen.getByRole('button', { name: 'CONTINUAR NO NAVEGADOR' }));
    expect(aoContinuar).toHaveBeenCalledOnce();
  });
});
