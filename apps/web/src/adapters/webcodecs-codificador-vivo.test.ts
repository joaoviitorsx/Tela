import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { CodificadorWebCodecs, REENVIO_MS, SEM_CAPTURA_MS } from './webcodecs-codificador.js';

/**
 * Captura parada (jogo minimizado no Alt+Tab, tela estática): o último quadro
 * é codificado de novo, para quem assiste não ficar sem pacote e quem entra
 * receber o quadro-chave.
 */
const ALVO: AlvoDoCodificador = { width: 1280, height: 720, fps: 60, bitrate: 6_000_000, limitadoPelaEstimativa: false };

const encodados: Array<{ timestamp: number; chave: boolean }> = [];
let fechados = 0;

class QuadroFalso {
  fechado = false;
  constructor(readonly timestamp: number) {}
  clone(): QuadroFalso {
    return new QuadroFalso(this.timestamp);
  }
  close(): void {
    if (!this.fechado) fechados += 1;
    this.fechado = true;
  }
}

class VideoFrameFalso extends QuadroFalso {
  constructor(base: QuadroFalso, init: { timestamp: number }) {
    super(init.timestamp);
    if (base.fechado) throw new Error('quadro fechado');
  }
}

class EncoderFalso {
  state = 'unconfigured';
  encodeQueueSize = 0;
  constructor(private readonly init: VideoEncoderInit) {}
  static isConfigSupported(): Promise<{ supported: boolean }> {
    return Promise.resolve({ supported: true });
  }
  configure(): void {
    this.state = 'configured';
  }
  encode(q: { timestamp: number }, o?: { keyFrame?: boolean }): void {
    encodados.push({ timestamp: q.timestamp, chave: o?.keyFrame === true });
    this.init.output({ timestamp: q.timestamp, type: o?.keyFrame ? 'key' : 'delta', byteLength: 4, copyTo: () => undefined } as unknown as EncodedVideoChunk);
  }
  close(): void {
    this.state = 'closed';
  }
}

class ProcessadorFalso {
  readonly readable: ReadableStream<unknown>;
  constructor(init: { track: { readonly readable: ReadableStream<unknown> } }) {
    this.readable = init.track.readable;
  }
}

function montar() {
  let t = 0;
  let controlador!: ReadableStreamDefaultController<unknown>;
  const readable = new ReadableStream<unknown>({ start: (c) => { controlador = c; } });
  const trilha = { readable } as unknown as MediaStreamTrack;
  let tiques = 0;
  const cod = new CodificadorWebCodecs(() => undefined, () => t, () => (tiques += 1));
  const capturar = async (ts: number) => {
    controlador.enqueue(new QuadroFalso(ts));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  };
  return { cod, trilha, capturar, passar: (ms: number) => { t += ms; }, tiques: () => tiques };
}

describe('CodificadorWebCodecs — captura parada', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const originais = { VideoEncoder: g['VideoEncoder'], MediaStreamTrackProcessor: g['MediaStreamTrackProcessor'], VideoFrame: g['VideoFrame'] };

  beforeEach(() => {
    encodados.length = 0;
    fechados = 0;
    g['VideoEncoder'] = EncoderFalso;
    g['MediaStreamTrackProcessor'] = ProcessadorFalso;
    g['VideoFrame'] = VideoFrameFalso;
  });
  afterEach(() => {
    Object.assign(g, originais);
  });

  it('captura andando: nada é reenviado', async () => {
    const { cod, trilha, capturar, passar } = montar();
    await cod.iniciar(trilha, ALVO);
    for (let i = 0; i < 10; i += 1) {
      await capturar(i * 16_000);
      passar(16);
      cod.manterVivo();
    }
    expect(encodados).toHaveLength(10);
  });

  it('captura parada: reenvia o último quadro a cada REENVIO_MS, com o tempo andando e a isca tocada', async () => {
    const { cod, trilha, capturar, passar, tiques } = montar();
    await cod.iniciar(trilha, ALVO);
    await capturar(1_000_000);
    const tiquesAntes = tiques();
    passar(SEM_CAPTURA_MS - 1);
    cod.manterVivo();
    expect(encodados).toHaveLength(1);
    passar(1);
    cod.manterVivo();
    expect(encodados).toHaveLength(2);
    expect(encodados[1]!.timestamp).toBe(1_000_000 + SEM_CAPTURA_MS * 1000);
    expect(tiques()).toBe(tiquesAntes + 1);
    passar(REENVIO_MS - 1);
    cod.manterVivo();
    expect(encodados).toHaveLength(2);
    passar(1);
    cod.manterVivo();
    expect(encodados).toHaveLength(3);
  });

  it('pedido de quadro-chave com a captura parada sai na hora, como IDR', async () => {
    const { cod, trilha, capturar, passar } = montar();
    await cod.iniciar(trilha, ALVO);
    await capturar(0);
    passar(SEM_CAPTURA_MS);
    cod.manterVivo();
    passar(10);
    cod.pedirChave('entrada', 1);
    cod.manterVivo();
    expect(encodados.at(-1)?.chave).toBe(true);
  });

  it('parar libera o último quadro guardado', async () => {
    const { cod, trilha, capturar } = montar();
    await cod.iniciar(trilha, ALVO);
    await capturar(0);
    const antes = fechados;
    cod.parar();
    expect(fechados).toBe(antes + 1);
    cod.manterVivo();
    expect(encodados).toHaveLength(1);
  });

  it('estatísticas separam o fps da captura do que o encoder produz', async () => {
    const { cod, trilha, capturar, passar } = montar();
    await cod.iniciar(trilha, ALVO);
    cod.estatisticas();
    await capturar(0);
    for (let i = 0; i < 4; i += 1) {
      passar(REENVIO_MS);
      cod.manterVivo();
    }
    const e = cod.estatisticas();
    expect(e.fpsDaCaptura).toBeLessThan(e.fps);
  });
});
