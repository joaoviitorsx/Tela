import { describe, expect, it } from 'vitest';
import { concluirSonda } from './sonda-de-rede.js';

const host = { tipo: 'host', portaPublica: null };
const srflx = (porta: number) => ({ tipo: 'srflx', portaPublica: porta });

describe('concluirSonda', () => {
  it('um srflx por saída local (medido num NAT comum): direta provável', () => {
    expect(concluirSonda({ candidatos: [host, host, srflx(58957), srflx(51529)], primeiraRespostaMs: 42, erro: null }))
      .toEqual({ direta: 'provavel', respostaMs: 42 });
  });

  it('mais srflx que saídas locais: dois servidores viram portas diferentes — NAT simétrico', () => {
    expect(concluirSonda({ candidatos: [host, srflx(40000), srflx(40123)], primeiraRespostaMs: 30, erro: null }).direta)
      .toBe('improvavel');
  });

  it('sem candidato local visível não se afirma simétrico', () => {
    expect(concluirSonda({ candidatos: [srflx(1), srflx(2)], primeiraRespostaMs: 30, erro: null }).direta)
      .toBe('provavel');
  });

  it('só candidato local: STUN não respondeu', () => {
    expect(concluirSonda({ candidatos: [host], primeiraRespostaMs: null, erro: null }))
      .toEqual({ direta: 'bloqueada', respostaMs: null });
  });

  it('erro antes de coletar vira falha, com o nome', () => {
    expect(concluirSonda({ candidatos: [], primeiraRespostaMs: null, erro: 'NotSupportedError' }))
      .toEqual({ direta: 'falhou', erro: 'NotSupportedError' });
  });
});
