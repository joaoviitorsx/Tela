import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ESPERA_PARA_VOLTAR_MS } from '../core/media/aceleracao-do-codificador.js';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { TRAVA_MS } from '../core/media/vigia-do-encoder.js';
import { CodificadorWebCodecs } from './webcodecs-codificador.js';

/**
 * GPU ou CPU, e a queda em tempo de execução (D9). O `VideoEncoder` é um dublê
 * que imita o Chromium medido: `prefer-hardware` sem GPU chama `error` DENTRO
 * do `configure`; um encoder vivo entrega cada quadro, a menos que esteja
 * "travado".
 */
const ALVO: AlvoDoCodificador = { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, limitadoPelaEstimativa: false, perfil: 'baseline', conteudo: 'motion' };

type Cena = {
  suportaHardware: boolean | 'lanca';
  /** `prefer-hardware` aceito no `isConfigSupported` mas recusado no `configure`. */
  gpuRecusaNoConfigure: boolean;
  /** Encoders vivos não entregam nada (driver travado). */
  travado: boolean;
};

const cena: Cena = { suportaHardware: true, gpuRecusaNoConfigure: false, travado: false };
const criados: EncoderFalso[] = [];

class EncoderFalso {
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  encodeQueueSize = 0;
  aceleracao: string | undefined;
  readonly chaves: boolean[] = [];
  constructor(private readonly init: VideoEncoderInit) {
    criados.push(this);
  }
  static isConfigSupported(c: VideoEncoderConfig): Promise<{ supported: boolean }> {
    if (cena.suportaHardware === 'lanca') return Promise.reject(new Error('sem WebCodecs'));
    const hw = c.hardwareAcceleration === 'prefer-hardware';
    return Promise.resolve({ supported: hw ? cena.suportaHardware : true });
  }
  configure(c: VideoEncoderConfig): void {
    this.aceleracao = c.hardwareAcceleration;
    if (c.hardwareAcceleration === 'prefer-hardware' && (cena.suportaHardware !== true || cena.gpuRecusaNoConfigure)) {
      this.state = 'closed';
      this.init.error(new DOMException('Encoder creation error.', 'OperationError'));
      return;
    }
    this.state = 'configured';
  }
  encode(q: { timestamp: number }, o?: { keyFrame?: boolean }): void {
    this.chaves.push(o?.keyFrame === true);
    if (cena.travado) {
      this.encodeQueueSize += 1;
      return;
    }
    const chunk = {
      timestamp: q.timestamp,
      type: o?.keyFrame === true ? 'key' : 'delta',
      byteLength: 4,
      copyTo: () => undefined,
    } as unknown as EncodedVideoChunk;
    this.init.output(chunk);
  }
  /** O encoder da GPU morre no meio (TDR). */
  morrer(): void {
    this.state = 'closed';
    this.init.error(new DOMException('GPU', 'OperationError'));
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

function montar(preferirHardware = true) {
  let t = 0;
  let controlador!: ReadableStreamDefaultController<unknown>;
  const readable = new ReadableStream<unknown>({ start: (c) => { controlador = c; } });
  const trilha = { readable } as unknown as MediaStreamTrack;
  const cod = new CodificadorWebCodecs(() => undefined, () => t, () => undefined, { preferirHardware });
  let carimbo = 0;
  const capturar = async () => {
    controlador.enqueue({ timestamp: carimbo++, close: () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const atual = () => criados[criados.length - 1];
  return { cod, trilha, capturar, atual, passar: (ms: number) => { t += ms; } };
}

describe('CodificadorWebCodecs — GPU, queda e volta', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const originais = { VideoEncoder: g['VideoEncoder'], MediaStreamTrackProcessor: g['MediaStreamTrackProcessor'] };

  beforeEach(() => {
    criados.length = 0;
    Object.assign(cena, { suportaHardware: true, gpuRecusaNoConfigure: false, travado: false });
    g['VideoEncoder'] = EncoderFalso;
    g['MediaStreamTrackProcessor'] = ProcessadorFalso;
  });
  afterEach(() => {
    g['VideoEncoder'] = originais.VideoEncoder;
    g['MediaStreamTrackProcessor'] = originais.MediaStreamTrackProcessor;
  });

  it('com GPU, o app pede prefer-hardware e o rótulo afirma hardware', async () => {
    const { cod, trilha, capturar, atual } = montar();
    await cod.iniciar(trilha, ALVO);
    await capturar();
    expect(atual()?.aceleracao).toBe('prefer-hardware');
    expect(cod.estatisticas()).toMatchObject({ implementacao: 'WebCodecs·hardware', hardware: true });
  });

  it('sem GPU: no-preference, como sempre, e o rótulo diz software', async () => {
    cena.suportaHardware = false;
    const { cod, trilha, atual } = montar();
    await cod.iniciar(trilha, ALVO);
    expect(atual()?.aceleracao).toBe('no-preference');
    expect(cod.estatisticas()).toMatchObject({ implementacao: 'WebCodecs·software', hardware: false });
  });

  it('a web não muda: no-preference mesmo com GPU, e não afirma o que não sabe', async () => {
    const { cod, trilha, atual } = montar(false);
    await cod.iniciar(trilha, ALVO);
    expect(atual()?.aceleracao).toBe('no-preference');
    expect(cod.estatisticas()).toMatchObject({ implementacao: 'WebCodecs', hardware: null });
  });

  it('sonda que lança: no-preference e rótulo neutro', async () => {
    cena.suportaHardware = 'lanca';
    const { cod, trilha, atual } = montar();
    await cod.iniciar(trilha, ALVO);
    expect(atual()?.aceleracao).toBe('no-preference');
    expect(cod.estatisticas().implementacao).toBe('WebCodecs');
  });

  it('GPU recusa dentro do configure: software na hora, primeiro quadro é IDR, nada pendurado', async () => {
    cena.gpuRecusaNoConfigure = true;
    const { cod, trilha, capturar, atual } = montar();
    await cod.iniciar(trilha, ALVO);
    await Promise.resolve(); // a microtarefa que recria
    expect(criados).toHaveLength(2);
    expect(criados[0]?.state).toBe('closed');
    expect(atual()?.aceleracao).toBe('prefer-software');
    await capturar();
    expect(atual()?.chaves).toEqual([true]);
    expect(cod.estatisticas()).toMatchObject({ implementacao: 'WebCodecs·software·GPU caiu', hardware: false });
  });

  it('GPU morre no meio (TDR): software sem derrubar a transmissão; volta à GPU depois de 30 s', async () => {
    const { cod, trilha, capturar, atual, passar } = montar();
    await cod.iniciar(trilha, ALVO);
    await capturar();
    atual()?.morrer();
    await Promise.resolve();
    expect(atual()?.aceleracao).toBe('prefer-software');
    await capturar();
    expect(atual()?.chaves).toEqual([true]); // quem assiste recomeça num IDR

    passar(ESPERA_PARA_VOLTAR_MS);
    cod.configurar(ALVO); // o tique de ~1 Hz do transporte
    expect(atual()?.aceleracao).toBe('prefer-hardware');
    await capturar();
    expect(atual()?.chaves).toEqual([true]);
    expect(cod.estatisticas().implementacao).toBe('WebCodecs·hardware');
    expect(criados.filter((e) => e.state !== 'closed')).toHaveLength(1);
  });

  it('driver travado: o vigia troca para software e a imagem volta', async () => {
    const { cod, trilha, capturar, atual, passar } = montar();
    await cod.iniciar(trilha, ALVO);
    cena.travado = true;
    for (let i = 0; i * 16 < TRAVA_MS + 100; i++) {
      await capturar();
      passar(16);
    }
    cena.travado = false;
    await Promise.resolve();
    await capturar();
    expect(atual()?.aceleracao).toBe('prefer-software');
    expect(atual()?.chaves[0]).toBe(true);
    expect(cod.estatisticas().implementacao).toBe('WebCodecs·software·GPU travou');
  });

  it('erro em software não vira laço: recria só no próximo configurar', async () => {
    cena.suportaHardware = false;
    const { cod, trilha, atual } = montar();
    await cod.iniciar(trilha, ALVO);
    atual()?.morrer();
    await Promise.resolve();
    expect(criados).toHaveLength(1);
    cod.configurar(ALVO);
    expect(criados).toHaveLength(2);
    expect(atual()?.aceleracao).toBe('no-preference');
  });

  it('parar não deixa microtarefa recriar encoder', async () => {
    const { cod, trilha, atual } = montar();
    await cod.iniciar(trilha, ALVO);
    atual()?.morrer();
    cod.parar();
    await Promise.resolve();
    expect(criados.every((e) => e.state === 'closed')).toBe(true);
    expect(criados).toHaveLength(1);
  });
});
