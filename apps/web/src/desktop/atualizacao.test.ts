import { describe, expect, it } from 'vitest';
import { linhaDeAtualizacao, ultimaVerificacao } from './atualizacao.js';
import type { EstadoDaAtualizacao } from './ponte.js';

const BASE: EstadoDaAtualizacao = {
  modo: 'automatica',
  fase: 'em-dia',
  versaoNova: null,
  progresso: null,
  ultimaVerificacaoMs: null,
  erro: null,
  adiada: false,
  podeVerificar: true,
  podeReiniciar: false,
  pagina: null,
};

describe('linhaDeAtualizacao', () => {
  it('uma frase por fase, com o tom certo', () => {
    expect(linhaDeAtualizacao(BASE)).toEqual({ tom: 'neutro', texto: 'Em dia.' });
    expect(linhaDeAtualizacao({ ...BASE, fase: 'baixando', versaoNova: '1.0.0', progresso: 42 }).texto).toBe('Baixando 1.0.0 42%');
    expect(linhaDeAtualizacao({ ...BASE, fase: 'pronta', versaoNova: '1.0.0', podeReiniciar: true })).toEqual({
      tom: 'pronta',
      texto: '1.0.0 pronta: reinicie para atualizar.',
    });
    expect(linhaDeAtualizacao({ ...BASE, fase: 'erro', erro: 'sem rede' })).toEqual({
      tom: 'erro',
      texto: 'Não deu para atualizar: sem rede',
    });
  });
  it('ao vivo, a versão pronta diz que instala ao sair; a achada diz que espera a transmissão', () => {
    expect(linhaDeAtualizacao({ ...BASE, fase: 'pronta', versaoNova: '1.0.0' }).texto).toMatch(/quando você sair/);
    expect(linhaDeAtualizacao({ ...BASE, fase: 'disponivel', versaoNova: '1.0.0', adiada: true }).texto).toMatch(
      /quando a transmissão acabar/,
    );
  });
});

describe('ultimaVerificacao', () => {
  const agora = new Date(2026, 9, 2, 15, 0).getTime();
  it('nunca, hoje, ontem e data', () => {
    expect(ultimaVerificacao(null, agora)).toBe('nunca');
    expect(ultimaVerificacao(new Date(2026, 9, 2, 14, 32).getTime(), agora)).toBe('hoje às 14:32');
    expect(ultimaVerificacao(new Date(2026, 9, 1, 9, 5).getTime(), agora)).toBe('ontem às 09:05');
    expect(ultimaVerificacao(new Date(2026, 8, 20, 18, 0).getTime(), agora)).toBe('20/09 às 18:00');
  });
});
