import { describe, expect, it } from 'vitest';
import { FORA_DO_AR } from './estado-ao-vivo.js';
import { TAMANHO_DO_PAINEL, chamadaDeAtualizacao, posicaoDoPainel, textoDoPainel } from './painel-sobre-o-jogo.js';

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

describe('painel sobre o jogo', () => {
  it('fica no canto pedido, dentro da área útil', () => {
    expect(posicaoDoPainel(AREA, 'sup-dir')).toEqual({ x: 1920 - TAMANHO_DO_PAINEL.largura - 16, y: 16 });
    expect(posicaoDoPainel(AREA, 'inf-esq')).toEqual({ x: 16, y: 1040 - TAMANHO_DO_PAINEL.altura - 16 });
    expect(posicaoDoPainel({ x: 1920, y: 0, width: 1280, height: 1000 }, 'sup-esq')).toEqual({ x: 1936, y: 16 });
  });

  it('fora do ar não há texto', () => {
    expect(textoDoPainel(FORA_DO_AR, 0)).toBeNull();
  });

  it('tempo no ar, quem assiste e o oculto', () => {
    const noAr = { ...FORA_DO_AR, noAr: true, inicioMs: 0, assistindo: 3, oculto: false };
    expect(textoDoPainel(noAr, 42_000)).toEqual({ tempo: '00:42', assistindo: 3, oculto: false });
    expect(textoDoPainel({ ...noAr, oculto: true }, 3_725_000)).toEqual({ tempo: '1:02:05', assistindo: 3, oculto: true });
  });

  it('a chamada é só dados serializados', () => {
    expect(chamadaDeAtualizacao({ tempo: '00:42', assistindo: 3, oculto: false })).toBe(
      'atualizar({"tempo":"00:42","assistindo":3,"oculto":false})',
    );
  });
});
