import { describe, expect, it } from 'vitest';
import { codificaH264, requisitosAusentes, suportaUmEncode } from './suporte-um-encode.js';

/** Um `window` de mentira: as três peças do D0b, como classes. */
const completo = {
  MediaStreamTrackProcessor: class {},
  VideoEncoder: class {},
  RTCRtpScriptTransform: class {},
};

describe('suportaUmEncode', () => {
  it('com as três peças, o navegador serve o "um encode, N envios"', () => {
    expect(suportaUmEncode(completo)).toBe(true);
    expect(requisitosAusentes(completo)).toEqual([]);
  });

  it('faltando QUALQUER uma, cai para o mesh puro', () => {
    for (const peca of Object.keys(completo)) {
      const sem = { ...completo, [peca]: undefined };
      expect(suportaUmEncode(sem), `sem ${peca}`).toBe(false);
      expect(requisitosAusentes(sem)).toEqual([peca]);
    }
  });

  it('a peça precisa ser construível: um valor que não é função não conta', () => {
    // Um polyfill que só reserva o nome — `window.VideoEncoder = {}` — não
    // codifica nada. Reportar suporte aqui montaria um transporte que falha
    // no primeiro quadro.
    expect(suportaUmEncode({ ...completo, VideoEncoder: {} })).toBe(false);
  });

  it('um global vazio (Firefox, Safari de hoje) não tem nada', () => {
    expect(suportaUmEncode({})).toBe(false);
    expect(requisitosAusentes({})).toEqual([
      'MediaStreamTrackProcessor',
      'VideoEncoder',
      'RTCRtpScriptTransform',
    ]);
  });
});

describe('codificaH264 — a API existir não basta', () => {
  const comResposta = (r: unknown) => ({ isConfigSupported: async () => r });
  it('aceita quando o encoder diz que suporta', async () => {
    expect(await codificaH264(comResposta({ supported: true }), 'avc1.42e02a')).toBe(true);
  });
  it('recusa quando o encoder recusa o perfil', async () => {
    expect(await codificaH264(comResposta({ supported: false }), 'avc1.42e02a')).toBe(false);
  });
  it('recusa quando a pergunta falha ou não existe', async () => {
    const quebra = { isConfigSupported: async () => { throw new Error('x'); } };
    expect(await codificaH264(quebra, 'avc1.42e02a')).toBe(false);
    expect(await codificaH264(undefined, 'avc1.42e02a')).toBe(false);
    expect(await codificaH264({}, 'avc1.42e02a')).toBe(false);
  });
});
