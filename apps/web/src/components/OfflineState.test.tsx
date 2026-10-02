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
});
