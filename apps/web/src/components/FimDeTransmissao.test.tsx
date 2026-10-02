// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FimDeTransmissao } from './FimDeTransmissao.js';

afterEach(cleanup);

const base = { titulo: 'COMPARTILHAMENTO CANCELADO', mensagem: 'm', canal: 'tela.gg/jv', resumo: null, acoes: null, diagnostico: null } as const;

describe('FimDeTransmissao', () => {
  it('falha: moldura vermelha e barras de teste', () => {
    const { container } = render(<FimDeTransmissao {...base} tom="falha" />);
    expect(container.querySelector('.chiado')).not.toBeNull();
    expect(container.innerHTML).toContain('border-danger-edge');
  });

  it('aviso (cancelou): moldura âmbar, sem barras nem chiado de alarme', () => {
    const { container } = render(<FimDeTransmissao {...base} tom="aviso" />);
    expect(container.querySelector('.chiado')).toBeNull();
    expect(container.innerHTML).toContain('border-warn-edge');
    expect(container.innerHTML).not.toContain('border-danger-edge');
  });

  it('normal: a TV desligando', () => {
    const { container } = render(<FimDeTransmissao {...base} titulo="FIM DA TRANSMISSÃO" tom="normal" />);
    expect(container.querySelector('.tv-desligando')).not.toBeNull();
  });
});
