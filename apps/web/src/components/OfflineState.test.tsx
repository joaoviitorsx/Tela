// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OfflineState } from './OfflineState.js';

afterEach(cleanup);

describe('OfflineState', () => {
  it('encerrada: diz que acabou, a hora, e que a aba continua escutando', () => {
    render(<OfflineState slug="jv" motivo="encerrada" maxPeers={5} encerradaEm="21:07" />);
    const estado = screen.getByRole('status');
    expect(estado.textContent).toMatch(/transmissão encerrada/);
    expect(estado.textContent).toMatch(/Terminou às 21:07/);
    expect(estado.textContent).toMatch(/recomeça sozinho/);
    expect(estado.textContent).not.toMatch(/aguardando sinal/);
  });

  it('aguardando sinal continua sendo o "ainda não começou"', () => {
    render(<OfflineState slug="jv" motivo="offline" maxPeers={5} />);
    expect(screen.getByRole('status').textContent).toMatch(/aguardando sinal/);
  });

  it('V-05: sem servidor começa pelo óbvio (a internet) e só depois cita o Brave', () => {
    render(<OfflineState slug="jv" motivo="sem-servidor" maxPeers={5} />);
    const texto = screen.getByRole('status').textContent ?? '';
    expect(texto).toMatch(/Verifique sua internet/);
    expect(texto.indexOf('internet')).toBeLessThan(texto.indexOf('Brave'));
  });

  it('V-10: sem vaga espera com LED âmbar (verde é "tudo certo") e diz que segue tentando', () => {
    const { container } = render(<OfflineState slug="jv" motivo="cheio" maxPeers={5} />);
    expect(screen.getByRole('status').textContent).toMatch(/seguimos tentando/);
    expect(container.querySelector('.led-pisca')?.className).toContain('bg-accent');
    expect(container.querySelector('.bg-ok')).toBeNull();
  });

  it('aguardando sinal mantém o LED verde', () => {
    const { container } = render(<OfflineState slug="jv" motivo="offline" maxPeers={5} />);
    expect(container.querySelector('.led-pisca')?.className).toContain('bg-ok');
  });
});
