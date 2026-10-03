import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { CodificadorWebCodecs } from './webcodecs-codificador.js';

/**
 * O perfil do codificador único (adendo à ADR 0016): Main só com a sala
 * pedindo e o modo de aceleração confirmando; B-frame derruba para Baseline.
 * `VideoEncoder` é dublê: registra cada `configure` e deixa o teste emitir
 * chunks na saída.
 */
const BASE: AlvoDoCodificador = { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, limitadoPelaEstimativa: false, perfil: 'baseline' };
const MAIN: AlvoDoCodificador = { ...BASE, perfil: 'main' };

let suportaMain = true;

class EncoderFalso {
  static ultimo: EncoderFalso | null = null;
  static configs: VideoEncoderConfig[] = [];
  static keyFrames = 0;
  state = 'unconfigured';
  encodeQueueSize = 0;
  constructor(readonly init: { output: (c: EncodedVideoChunk) => void; error: (e: unknown) => void }) {
    EncoderFalso.ultimo = this;
  }
  static isConfigSupported(c: VideoEncoderConfig): Promise<{ supported: boolean }> {
    return Promise.resolve({ supported: c.codec.startsWith('avc1.4d') ? suportaMain : true });
  }
  configure(c: VideoEncoderConfig): void {
    EncoderFalso.configs.push(c);
    this.state = 'configured';
  }
  encode(_q: unknown, o?: { keyFrame?: boolean }): void {
    if (o?.keyFrame === true) EncoderFalso.keyFrames += 1;
  }
  close(): void {
    this.state = 'closed';
  }
}

/** Um chunk Annex B: SPS com o `profile_idc` dado, ou um P sem SPS. */
function chunk(timestamp: number, profileIdc: number | null): EncodedVideoChunk {
  const bytes =
    profileIdc === null ? new Uint8Array([0, 0, 0, 1, 0x41, 0x9a]) : new Uint8Array([0, 0, 0, 1, 0x67, profileIdc, 0, 0x2a]);
  return {
    type: profileIdc === null ? 'delta' : 'key',
    timestamp,
    byteLength: bytes.byteLength,
    copyTo: (destino: ArrayBuffer) => new Uint8Array(destino).set(bytes),
  } as unknown as EncodedVideoChunk;
}

const assentar = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('CodificadorWebCodecs — perfil H.264 da sala', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const originais = { VideoEncoder: g['VideoEncoder'], MediaStreamTrackProcessor: g['MediaStreamTrackProcessor'] };
  /** Uma trilha por caso: o leitor do codificador trava o stream. */
  const novaTrilha = () => ({ readable: new ReadableStream() }) as unknown as MediaStreamTrack;

  beforeEach(() => {
    suportaMain = true;
    EncoderFalso.configs = [];
    EncoderFalso.keyFrames = 0;
    g['VideoEncoder'] = EncoderFalso;
    g['MediaStreamTrackProcessor'] = class {
      readonly readable: ReadableStream;
      constructor(init: { track: { readable: ReadableStream } }) {
        this.readable = init.track.readable;
      }
    };
  });
  afterEach(() => {
    g['VideoEncoder'] = originais.VideoEncoder;
    g['MediaStreamTrackProcessor'] = originais.MediaStreamTrackProcessor;
  });

  const codecs = () => EncoderFalso.configs.map((c) => c.codec);

  it('sala em Baseline: só Baseline', async () => {
    const cod = new CodificadorWebCodecs(() => undefined, () => 0);
    await cod.iniciar(novaTrilha(), BASE);
    await assentar();
    expect(new Set(codecs())).toEqual(new Set(['avc1.42e02a']));
  });

  it('sala em Main e o modo confirma: reconfigura para Main', async () => {
    const cod = new CodificadorWebCodecs(() => undefined, () => 0);
    await cod.iniciar(novaTrilha(), MAIN);
    await assentar();
    expect(codecs().at(-1)).toBe('avc1.4d002a');
    cod.parar();
  });

  it('o modo recusa Main: fica em Baseline, sem acusar a GPU', async () => {
    suportaMain = false;
    const cod = new CodificadorWebCodecs(() => undefined, () => 0);
    await cod.iniciar(novaTrilha(), MAIN);
    await assentar();
    expect(new Set(codecs())).toEqual(new Set(['avc1.42e02a']));
    expect(cod.estatisticas().hardware).not.toBe(false);
    cod.parar();
  });

  it('B-frame (timestamp voltando) proíbe Main e volta a Baseline', async () => {
    const cod = new CodificadorWebCodecs(() => undefined, () => 0);
    await cod.iniciar(novaTrilha(), MAIN);
    await assentar();
    expect(codecs().at(-1)).toBe('avc1.4d002a');
    const saida = EncoderFalso.ultimo!.init.output;
    saida(chunk(100, 77));
    saida(chunk(80, null));
    await assentar();
    expect(codecs().at(-1)).toBe('avc1.42e02a');
    cod.configurar(MAIN);
    await assentar();
    expect(codecs().at(-1)).toBe('avc1.42e02a');
    cod.parar();
  });

  it('o console mostra o perfil EMITIDO, lido do SPS', async () => {
    const cod = new CodificadorWebCodecs(() => undefined, () => 0);
    await cod.iniciar(novaTrilha(), MAIN);
    await assentar();
    EncoderFalso.ultimo!.init.output(chunk(1, 66));
    expect(cod.estatisticas().implementacao).toContain('H.264 Baseline');
    EncoderFalso.ultimo!.init.output(chunk(2, 77));
    expect(cod.estatisticas().implementacao).toContain('H.264 Main');
    cod.parar();
  });
});
