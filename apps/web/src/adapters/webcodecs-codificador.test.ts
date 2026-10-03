import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import type { ChunkInjetado } from './injecao-worker.js';
import { CodificadorWebCodecs } from './webcodecs-codificador.js';

/**
 * Só a coalescência de quadro-chave: o resto do codificador é WebCodecs de
 * verdade e fica para o navegador (`um-encode.e2e.mjs`). Aqui `VideoEncoder` e
 * `MediaStreamTrackProcessor` são dublês que registram o `keyFrame` de cada
 * `encode`.
 */
const ALVO: AlvoDoCodificador = { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, limitadoPelaEstimativa: false, perfil: 'baseline', conteudo: 'motion', camadas: 1, codec: 'h264' };

type Codificado = { readonly keyFrame: boolean };

class VideoEncoderFalso {
  static codificados: Codificado[] = [];
  state = 'unconfigured';
  encodeQueueSize = 0;
  static isConfigSupported(): Promise<{ supported: boolean }> {
    return Promise.resolve({ supported: true });
  }
  configure(): void {
    this.state = 'configured';
  }
  encode(_quadro: unknown, opcoes?: { keyFrame?: boolean }): void {
    VideoEncoderFalso.codificados.push({ keyFrame: opcoes?.keyFrame === true });
  }
  close(): void {
    this.state = 'closed';
  }
}

type QuadroFalso = { readonly timestamp: number; close(): void };

/** A trilha É o stream: o dublê de `MediaStreamTrackProcessor` só o repassa. */
class ProcessadorFalso {
  readonly readable: ReadableStream<QuadroFalso>;
  constructor(init: { track: { readonly readable: ReadableStream<QuadroFalso> } }) {
    this.readable = init.track.readable;
  }
}

function montar() {
  let t = 0;
  const entregues: ChunkInjetado[] = [];
  let controlador!: ReadableStreamDefaultController<QuadroFalso>;
  const readable = new ReadableStream<QuadroFalso>({ start: (c) => { controlador = c; } });
  const trilha = { readable } as unknown as MediaStreamTrack;
  const cod = new CodificadorWebCodecs((c) => entregues.push(c), () => t);
  let timestamp = 0;
  const capturar = async () => {
    controlador.enqueue({ timestamp: timestamp++, close: () => undefined });
    // O leitor consome num microtask; dois bastam para o `encode` acontecer.
    await Promise.resolve();
    await Promise.resolve();
  };
  return { cod, trilha, capturar, passar: (ms: number) => { t += ms; }, chaves: () => VideoEncoderFalso.codificados.filter((c) => c.keyFrame).length };
}

describe('CodificadorWebCodecs — coalescência de quadro-chave', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const originais = { VideoEncoder: g['VideoEncoder'], MediaStreamTrackProcessor: g['MediaStreamTrackProcessor'] };

  beforeEach(() => {
    VideoEncoderFalso.codificados = [];
    g['VideoEncoder'] = VideoEncoderFalso;
    g['MediaStreamTrackProcessor'] = ProcessadorFalso;
  });
  afterEach(() => {
    g['VideoEncoder'] = originais.VideoEncoder;
    g['MediaStreamTrackProcessor'] = originais.MediaStreamTrackProcessor;
  });

  it('o primeiro quadro é IDR; pedidos em rajada dentro de 500 ms não viram outro', async () => {
    const { cod, trilha, capturar, passar, chaves } = montar();
    await cod.iniciar(trilha, ALVO);
    await capturar();
    expect(chaves()).toBe(1);
    passar(100);
    cod.pedirChave('pli', 3);
    cod.pedirChave('entrada', 3);
    await capturar();
    expect(chaves()).toBe(1);
    passar(400);
    cod.pedirChave('pli', 3);
    await capturar();
    expect(chaves()).toBe(2);
  });

  it('com 50 senders, PLI espera 2 s; a entrada só 500 ms', async () => {
    const { cod, trilha, capturar, passar, chaves } = montar();
    await cod.iniciar(trilha, ALVO);
    await capturar(); // IDR em t=0
    passar(1_000);
    cod.pedirChave('pli', 50);
    await capturar();
    expect(chaves()).toBe(1);
    cod.pedirChave('entrada', 50);
    await capturar();
    expect(chaves()).toBe(2); // t=1 s: a entrada abriu (≥ 500 ms do último IDR)
    passar(1_999);
    cod.pedirChave('pli', 50);
    await capturar();
    expect(chaves()).toBe(2);
    passar(1);
    cod.pedirChave('pli', 50);
    await capturar();
    expect(chaves()).toBe(3);
    expect(cod.estatisticas().pedidosDeChave).toEqual({ pli: 3, entrada: 1 });
  });

  it('o pedido que caiu na janela não fica pendente: só o próximo, fora dela, vira IDR', async () => {
    const { cod, trilha, capturar, passar, chaves } = montar();
    await cod.iniciar(trilha, ALVO);
    await capturar();
    passar(200);
    cod.pedirChave('pli', 50);
    passar(5_000);
    await capturar();
    await capturar();
    expect(chaves()).toBe(1);
    cod.pedirChave('pli', 50);
    await capturar();
    expect(chaves()).toBe(2);
  });
});
