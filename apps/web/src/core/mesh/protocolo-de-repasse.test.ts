import { describe, expect, it } from 'vitest';
import { MAX_BYTES_DO_VIA, ehDoRepasse, lerDoAnfitriao, lerDoEspectador } from './protocolo-de-repasse.js';

describe('protocolo de repasse', () => {
  it('não se confunde com o SignalPayload do PeerLink', () => {
    expect(ehDoRepasse({ description: { type: 'offer', sdp: '' } })).toBe(false);
    expect(ehDoRepasse({ candidate: null })).toBe(false);
    expect(ehDoRepasse({ repasse: 'estado' })).toBe(true);
  });

  it('lê o que o espectador manda e recusa campo fora do formato', () => {
    expect(lerDoEspectador({ repasse: 'estado', versao: 1, podeRepassar: true, rttMs: 12 })).toEqual({
      repasse: 'estado',
      versao: 1,
      podeRepassar: true,
      rttMs: 12,
    });
    expect(lerDoEspectador({ repasse: 'estado', versao: 1, podeRepassar: 'sim', rttMs: 12 })).toBeNull();
    expect(lerDoEspectador({ repasse: 'estado', versao: 1, podeRepassar: true, rttMs: -1 })).toBeNull();
    expect(lerDoEspectador({ repasse: 'relatorio', filhos: 2, piorSaidaBps: null, sobrecarregado: false })).not.toBeNull();
    expect(lerDoEspectador({ repasse: 'relatorio', filhos: 1.5, piorSaidaBps: null, sobrecarregado: false })).toBeNull();
    expect(lerDoEspectador({ repasse: 'com-pai' })).toEqual({ repasse: 'com-pai' });
    expect(lerDoEspectador({ repasse: 'sem-pai' })).toEqual({ repasse: 'sem-pai' });
    expect(lerDoEspectador({ repasse: 'pai', pai: null })).toBeNull();
    expect(lerDoEspectador('texto')).toBeNull();
  });

  it('via: destino obrigatório e tamanho limitado', () => {
    expect(lerDoEspectador({ repasse: 'via', para: 'x', dados: { candidate: null } })).not.toBeNull();
    expect(lerDoEspectador({ repasse: 'via', para: '', dados: {} })).toBeNull();
    expect(lerDoEspectador({ repasse: 'via', para: 'x', dados: 'a'.repeat(MAX_BYTES_DO_VIA) })).toBeNull();
  });

  it('lê o que o anfitrião manda', () => {
    expect(lerDoAnfitriao({ repasse: 'pai', pai: null })).toEqual({ repasse: 'pai', pai: null });
    expect(lerDoAnfitriao({ repasse: 'pai', pai: 'r' })).toEqual({ repasse: 'pai', pai: 'r' });
    expect(lerDoAnfitriao({ repasse: 'pai', pai: 3 })).toBeNull();
    expect(lerDoAnfitriao({ repasse: 'filho', filho: 'f' })).toEqual({ repasse: 'filho', filho: 'f' });
    expect(lerDoAnfitriao({ repasse: 'soltar', filho: 'f' })).toEqual({ repasse: 'soltar', filho: 'f' });
    expect(lerDoAnfitriao({ repasse: 'via', de: 'r', dados: {} })).toEqual({ repasse: 'via', de: 'r', dados: {} });
    expect(lerDoAnfitriao({ repasse: 'estado' })).toBeNull();
  });
});
