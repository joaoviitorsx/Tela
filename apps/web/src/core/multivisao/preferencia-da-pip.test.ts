import { describe, expect, it } from 'vitest';
import { FakeStorage } from '../testing/fakes.js';
import { PIP_PADRAO } from './estado.js';
import { PIP_KEY, makePreferenciaDaPip } from './preferencia-da-pip.js';

describe('preferência da PiP', () => {
  it('sem nada guardado, o padrão', () => {
    expect(makePreferenciaDaPip(new FakeStorage()).ler()).toEqual(PIP_PADRAO);
  });

  it('grava e lê', () => {
    const p = makePreferenciaDaPip(new FakeStorage());
    p.gravar({ canto: 'sup-esq', tamanho: 'g' });
    expect(p.ler()).toEqual({ canto: 'sup-esq', tamanho: 'g' });
  });

  it('valor estranho volta ao padrão campo a campo', () => {
    const s = new FakeStorage();
    s.set(PIP_KEY, JSON.stringify({ canto: 'meio', tamanho: 'g' }));
    expect(makePreferenciaDaPip(s).ler()).toEqual({ canto: PIP_PADRAO.canto, tamanho: 'g' });
    s.set(PIP_KEY, '{');
    expect(makePreferenciaDaPip(s).ler()).toEqual(PIP_PADRAO);
  });
});
