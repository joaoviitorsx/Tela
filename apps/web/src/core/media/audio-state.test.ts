import { describe, expect, it } from 'vitest';
import type { AudioStats } from './audio-stats.js';
import {
  AMOSTRAS_PARA_ENTRAR,
  AMOSTRAS_PARA_SAIR,
  ClassificadorDeAudio,
  SILENCIO_AVISO_MS,
  type EntradaAudio,
} from './audio-state.js';

const stats = (extra: Partial<AudioStats> = {}): AudioStats => ({
  fluxos: 1,
  bitrateBps: 128_000,
  nivel: 0.1,
  perda: 0,
  jitterMs: 4,
  jitterBufferMs: 60,
  ocultacao: 0,
  eventosOcultacao: 0,
  codec: null,
  configuracao: null,
  ...extra,
});

const viva = (agora: number, extra: Partial<EntradaAudio> = {}): EntradaAudio => ({
  trilha: 'viva',
  mudoIntencional: false,
  reproducaoBloqueada: false,
  stats: stats(),
  agora,
  ...extra,
});

describe('ClassificadorDeAudio', () => {
  it('sem trilha é sem-fonte; trilha que acabou é encerrada', () => {
    const c = new ClassificadorDeAudio();
    expect(c.observar(viva(0, { trilha: 'ausente', stats: null }))).toBe('sem-fonte');
    expect(c.observar(viva(0, { trilha: 'encerrada' }))).toBe('encerrada');
  });

  it('trilha viva sem medida é desconhecido, não "transmitindo"', () => {
    const c = new ClassificadorDeAudio();
    expect(c.observar(viva(0, { stats: null }))).toBe('desconhecido');
    expect(c.observar(viva(0, { stats: stats({ bitrateBps: null, nivel: null }) }))).toBe('desconhecido');
  });

  it('bloqueio de reprodução vence mudo e perda', () => {
    const c = new ClassificadorDeAudio();
    expect(c.observar(viva(0, { reproducaoBloqueada: true, mudoIntencional: true }))).toBe('bloqueado');
  });

  it('silêncio curto é silêncio, não defeito', () => {
    const c = new ClassificadorDeAudio();
    const calado = stats({ nivel: 0 });
    expect(c.observar(viva(0, { stats: calado }))).toBe('transmitindo');
    expect(c.observar(viva(SILENCIO_AVISO_MS - 1, { stats: calado }))).toBe('transmitindo');
    expect(c.observar(viva(SILENCIO_AVISO_MS, { stats: calado }))).toBe('sem-sinal');
    // Um único instante de som volta ao normal e zera o relógio.
    expect(c.observar(viva(SILENCIO_AVISO_MS + 1_000))).toBe('transmitindo');
    expect(c.observar(viva(SILENCIO_AVISO_MS + 2_000, { stats: calado }))).toBe('transmitindo');
  });

  it('nível ausente não sustenta "sem sinal"', () => {
    const c = new ClassificadorDeAudio();
    c.observar(viva(0, { stats: stats({ nivel: 0 }) }));
    c.observar(viva(10_000, { stats: stats({ nivel: null }) }));
    expect(c.observar(viva(SILENCIO_AVISO_MS + 1, { stats: stats({ nivel: 0 }) }))).toBe('transmitindo');
  });

  it('volume zero escolhido é mudo, e não conta como silêncio da fonte', () => {
    const c = new ClassificadorDeAudio();
    const calado = stats({ nivel: 0 });
    expect(c.observar(viva(0, { stats: calado, mudoIntencional: true }))).toBe('mudo');
    expect(c.observar(viva(SILENCIO_AVISO_MS * 2, { stats: calado, mudoIntencional: true }))).toBe('mudo');
    // Desmutou: o relógio de silêncio começa agora, não lá atrás.
    expect(c.observar(viva(SILENCIO_AVISO_MS * 2 + 1, { stats: calado }))).toBe('transmitindo');
  });

  it('perda entra só depois de amostras seguidas, e sai com histerese', () => {
    const c = new ClassificadorDeAudio();
    const ruim = stats({ ocultacao: 0.1 });
    const meio = stats({ ocultacao: 0.03 });
    const boa = stats({ ocultacao: 0 });

    for (let i = 0; i < AMOSTRAS_PARA_ENTRAR - 1; i++) {
      expect(c.observar(viva(i * 1_000, { stats: ruim }))).toBe('transmitindo');
    }
    expect(c.observar(viva(10_000, { stats: ruim }))).toBe('perda');

    // Entre os limiares: não sai.
    for (let i = 0; i < 10; i++) expect(c.observar(viva(11_000 + i, { stats: meio }))).toBe('perda');

    for (let i = 0; i < AMOSTRAS_PARA_SAIR - 1; i++) {
      expect(c.observar(viva(20_000 + i, { stats: boa }))).toBe('perda');
    }
    expect(c.observar(viva(30_000, { stats: boa }))).toBe('transmitindo');
  });

  it('uma rajada isolada não acende o aviso', () => {
    const c = new ClassificadorDeAudio();
    c.observar(viva(0, { stats: stats({ ocultacao: 0.2 }) }));
    c.observar(viva(1, { stats: stats({ ocultacao: 0 }) }));
    c.observar(viva(2, { stats: stats({ ocultacao: 0.2 }) }));
    expect(c.observar(viva(3, { stats: stats({ ocultacao: 0.2 }) }))).toBe('transmitindo');
  });
});
