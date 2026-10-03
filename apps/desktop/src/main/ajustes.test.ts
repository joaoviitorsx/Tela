import { describe, expect, it } from 'vitest';
import { AJUSTES_PADRAO, lerAjustes, mesclarAjustes, mesmosAjustes, serializarAjustes } from './ajustes.js';

describe('ajustes', () => {
  it('sem arquivo, JSON quebrado ou de outro tipo: o padrão', () => {
    expect(lerAjustes(null)).toEqual(AJUSTES_PADRAO);
    expect(lerAjustes('{quebrado')).toEqual(AJUSTES_PADRAO);
    expect(lerAjustes('[1,2]')).toEqual(AJUSTES_PADRAO);
    expect(lerAjustes('"x"')).toEqual(AJUSTES_PADRAO);
  });

  it('o padrão nunca inicia com o sistema nem lembra escolhas', () => {
    expect(AJUSTES_PADRAO.iniciarComSistema).toBe(false);
    expect(AJUSTES_PADRAO.aoFecharAoVivo).toBe('perguntar');
  });

  it('atualizar automaticamente vem ligado, e só um booleano o muda', () => {
    expect(AJUSTES_PADRAO.atualizarAutomaticamente).toBe(true);
    expect(mesclarAjustes(AJUSTES_PADRAO, { atualizarAutomaticamente: false }).atualizarAutomaticamente).toBe(false);
    expect(mesclarAjustes(AJUSTES_PADRAO, { atualizarAutomaticamente: 'nao' }).atualizarAutomaticamente).toBe(true);
    expect(mesclarAjustes(AJUSTES_PADRAO, { atualizarAutomaticamente: 0 }).atualizarAutomaticamente).toBe(true);
    expect(lerAjustes('{"atualizarAutomaticamente":false}').atualizarAutomaticamente).toBe(false);
    expect(mesmosAjustes(AJUSTES_PADRAO, { ...AJUSTES_PADRAO, atualizarAutomaticamente: false })).toBe(false);
  });

  it('o que grava, lê de volta', () => {
    const a = { ...AJUSTES_PADRAO, iniciarComSistema: true, aoFecharAoVivo: 'segundo-plano' as const };
    expect(lerAjustes(serializarAjustes(a))).toEqual(a);
  });

  it('campo com tipo errado volta ao padrão, os bons ficam', () => {
    const lido = lerAjustes(
      JSON.stringify({ iniciarComSistema: 'sim', fecharEmSegundoPlano: true, aoFecharAoVivo: 'tchau', extra: 1 }),
    );
    expect(lido).toEqual({ ...AJUSTES_PADRAO, fecharEmSegundoPlano: true });
    expect(Object.keys(lido)).not.toContain('extra');
  });

  it('mesclar muda só o que veio e ignora o que não é objeto', () => {
    const base = { ...AJUSTES_PADRAO, sempreNoTopoNoCompacto: true };
    expect(mesclarAjustes(base, { iniciarComSistema: true })).toEqual({ ...base, iniciarComSistema: true });
    expect(mesclarAjustes(base, null)).toBe(base);
    expect(mesclarAjustes(base, 'x')).toBe(base);
    expect(mesclarAjustes(base, { aoFecharAoVivo: 'encerrar' }).aoFecharAoVivo).toBe('encerrar');
  });

  it('mesmosAjustes compara campo a campo', () => {
    expect(mesmosAjustes(AJUSTES_PADRAO, { ...AJUSTES_PADRAO })).toBe(true);
    expect(mesmosAjustes(AJUSTES_PADRAO, { ...AJUSTES_PADRAO, iniciarComSistema: true })).toBe(false);
  });

  it('painel sobre o jogo: desligado por padrão; canto só entre os quatro', () => {
    expect(AJUSTES_PADRAO.painelSobreOJogo).toBe(false);
    expect(mesclarAjustes(AJUSTES_PADRAO, { painelSobreOJogo: true }).painelSobreOJogo).toBe(true);
    expect(mesclarAjustes(AJUSTES_PADRAO, { cantoDoPainel: 'inf-esq' }).cantoDoPainel).toBe('inf-esq');
    expect(mesclarAjustes(AJUSTES_PADRAO, { cantoDoPainel: 'meio' }).cantoDoPainel).toBe('sup-dir');
    expect(mesmosAjustes(AJUSTES_PADRAO, { ...AJUSTES_PADRAO, cantoDoPainel: 'inf-dir' })).toBe(false);
  });
});
