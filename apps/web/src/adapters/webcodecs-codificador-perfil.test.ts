import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { CodificadorWebCodecs } from './webcodecs-codificador.js';

/**
 * O perfil do codificador único (adendo à ADR 0016): Main só com a sala
 * pedindo e o modo de aceleração confirmando; B-frame derruba para Baseline.
 * `VideoEncoder` é dublê: registra cada `configure` e deixa o teste emitir
 * chunks na saída.
 */
const BASE: AlvoDoCodificador = { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, limitadoPelaEstimativa: false, perfil: 'baseline', conteudo: 'motion', camadas: 1 };
const MAIN: AlvoDoCodificador = { ...BASE, perfil: 'main' };

let suportaMain = true;
/** O `configure` em Main estoura (driver que mente no `isConfigSupported`). */
let mainQuebraNoConfigure = false;

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
  static carimbos: number[] = [];
  configure(c: VideoEncoderConfig): void {
    EncoderFalso.configs.push(c);
    if (mainQuebraNoConfigure && c.codec.startsWith('avc1.4d')) {
      this.init.error(new Error('Encoder creation error.'));
      return;
    }
    this.state = 'configured';
  }
  encode(q: { timestamp: number }, o?: { keyFrame?: boolean }): void {
    EncoderFalso.carimbos.push(q.timestamp);
    if (o?.keyFrame === true) EncoderFalso.keyFrames += 1;
  }
  close(): void {
    this.state = 'closed';
  }
}

/** `VideoFrame` mínimo: recarimbar (`new VideoFrame(q, {timestamp})`) e fechar. */
class QuadroFalso {
  readonly timestamp: number;
  constructor(base: { timestamp: number }, init?: { timestamp?: number }) {
    this.timestamp = init?.timestamp ?? base.timestamp;
  }
  clone(): QuadroFalso {
    return new QuadroFalso(this);
  }
  close(): void {}
}

/** Uma trilha que solta quadros com os carimbos dados. */
function trilhaCom(): { trilha: MediaStreamTrack; soltar: (ts: number) => Promise<void> } {
  let c!: ReadableStreamDefaultController<QuadroFalso>;
  const readable = new ReadableStream<QuadroFalso>({ start: (x) => { c = x; } });
  return {
    trilha: { readable } as unknown as MediaStreamTrack,
    soltar: async (ts) => {
      c.enqueue(new QuadroFalso({ timestamp: ts }));
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    },
  };
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
  const originais = {
    VideoEncoder: g['VideoEncoder'],
    MediaStreamTrackProcessor: g['MediaStreamTrackProcessor'],
    VideoFrame: g['VideoFrame'],
  };
  /** Uma trilha por caso: o leitor do codificador trava o stream. */
  const novaTrilha = () => ({ readable: new ReadableStream() }) as unknown as MediaStreamTrack;

  beforeEach(() => {
    suportaMain = true;
    mainQuebraNoConfigure = false;
    EncoderFalso.configs = [];
    EncoderFalso.carimbos = [];
    g['VideoFrame'] = QuadroFalso;
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
    g['VideoFrame'] = originais.VideoFrame;
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

  it('trilha nova recomeça o carimbo em 0: a entrada segue monotônica e Main NÃO é proibido', async () => {
    const cod = new CodificadorWebCodecs(() => undefined, () => 0);
    const a = trilhaCom();
    await cod.iniciar(a.trilha, MAIN);
    await assentar();
    await a.soltar(1_000_000);
    await a.soltar(1_016_667);
    const b = trilhaCom();
    cod.trocarFonte(b.trilha);
    await b.soltar(0);
    await b.soltar(16_667);
    const c = EncoderFalso.carimbos;
    for (let i = 1; i < c.length; i += 1) expect(c[i]).toBeGreaterThan(c[i - 1]!);
    // O espaçamento da trilha nova se preserva (é o que o controle de taxa lê).
    expect(c.at(-1)! - c.at(-2)!).toBe(16_667);
    // Saídas na ordem da entrada: nenhum B-frame visto, Main continua.
    for (const [i, ts] of c.entries()) EncoderFalso.ultimo!.init.output(chunk(ts, i === 0 ? 77 : null));
    await assentar();
    expect(codecs().at(-1)).toBe('avc1.4d002a');
    cod.parar();
  });

  it('Main estoura no configure: volta a Baseline no MESMO modo, sem acusar a GPU', async () => {
    mainQuebraNoConfigure = true;
    const cod = new CodificadorWebCodecs(() => undefined, () => 0, () => undefined, { preferirHardware: true });
    await cod.iniciar(trilhaCom().trilha, MAIN);
    await assentar();
    const modos = EncoderFalso.configs.map((c) => c.hardwareAcceleration);
    expect(codecs().at(-1)).toBe('avc1.42e02a');
    expect(new Set(modos)).toEqual(new Set(['prefer-hardware']));
    cod.parar();
  });

  it('detail NUNCA vai a encoder que não é hardware certo (OpenH264: IDR por quadro)', async () => {
    const cod = new CodificadorWebCodecs(() => undefined, () => 0);
    await cod.iniciar(novaTrilha(), BASE);
    await assentar();
    cod.configurar({ ...BASE, conteudo: 'detail', fps: 30 });
    expect(EncoderFalso.configs.at(-1)?.contentHint).toBe('motion');
    cod.parar();
  });

  it('hardware: detail chega; três chaves espontâneas em 10 s o derrubam para motion', async () => {
    let t = 0;
    const cod = new CodificadorWebCodecs(() => undefined, () => t, () => undefined, { preferirHardware: true });
    await cod.iniciar(novaTrilha(), BASE);
    await assentar();
    cod.configurar({ ...BASE, conteudo: 'detail', fps: 30 });
    expect(EncoderFalso.configs.at(-1)?.contentHint).toBe('detail');
    const saida = EncoderFalso.ultimo!.init.output;
    for (let i = 0; i < 3; i += 1) {
      t += 1_000;
      saida(chunk(i * 33_333, 66));
    }
    await assentar();
    expect(EncoderFalso.configs.at(-1)?.contentHint).toBe('motion');
    cod.configurar({ ...BASE, conteudo: 'detail', fps: 30 });
    expect(EncoderFalso.configs.at(-1)?.contentHint).toBe('motion');
    cod.parar();
  });

  it('modo de taxa: variable por padrão; trocar para constant reconfigura', async () => {
    let modo: 'variable' | 'constant' = 'variable';
    const cod = new CodificadorWebCodecs(() => undefined, () => 0, () => undefined, { modoDeTaxa: () => modo });
    await cod.iniciar(novaTrilha(), BASE);
    await assentar();
    expect(EncoderFalso.configs.at(-1)?.bitrateMode).toBe('variable');
    modo = 'constant';
    cod.configurar(BASE);
    expect(EncoderFalso.configs.at(-1)?.bitrateMode).toBe('constant');
    const n = EncoderFalso.configs.length;
    cod.configurar(BASE);
    expect(EncoderFalso.configs.length).toBe(n);
    cod.parar();
  });

  it('L1T2 com a sala pedindo: scalabilityMode vai ao encoder e a camada vai com o quadro', async () => {
    const entregues: { camada?: number }[] = [];
    const cod = new CodificadorWebCodecs((c) => entregues.push(c), () => 0);
    await cod.iniciar(novaTrilha(), { ...BASE, camadas: 2 });
    await assentar();
    expect(EncoderFalso.configs.at(-1)?.scalabilityMode).toBe('L1T2');
    const saida = EncoderFalso.ultimo!.init.output as unknown as (c: EncodedVideoChunk, m?: unknown) => void;
    saida(chunk(1, 66), { svc: { temporalLayerId: 0 } });
    saida(chunk(2, null), { svc: { temporalLayerId: 1 } });
    expect(entregues.map((e) => e.camada)).toEqual([0, 1]);
    cod.configurar({ ...BASE, camadas: 1 });
    expect(EncoderFalso.configs.at(-1)?.scalabilityMode).toBeUndefined();
    cod.parar();
  });
});
