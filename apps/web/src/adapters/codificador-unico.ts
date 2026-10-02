import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import type { ChunkInjetado } from './injecao-worker.js';

/**
 * O codificador ÚNICO do "um encode, N envios", visto pelo transporte.
 *
 * Duas implementações: `CodificadorWebCodecs` (o Chromium codifica a trilha
 * capturada) e `CodificadorExterno` (um processo nativo captura e codifica
 * sozinho — NVENC no Linux, D0c). O transporte não sabe qual é.
 */
export type EstatisticasDoCodificador = {
  readonly width: number;
  readonly height: number;
  /** Quadros codificados por segundo, medidos desde a última leitura. */
  readonly fps: number;
  /** Tempo médio entre entregar o quadro ao encoder e receber o resultado. */
  readonly msPorQuadro: number | null;
  readonly bitrateAlvo: number;
  /** `true`/`false` quando dá para afirmar; `null` quando não. */
  readonly hardware: boolean | null;
  /** O encoder não está dando conta: é CPU/GPU, não rede. */
  readonly sobrecarregado: boolean;
  readonly idrs: number;
  /** Pedidos de quadro-chave recebidos, por motivo — diagnóstico. */
  readonly pedidosDeChave: Readonly<Record<string, number>>;
  /** Rótulo para o console da transmissão (`encoderImplementation`). */
  readonly implementacao: string;
};

export interface CodificadorUnico {
  iniciar(track: MediaStreamTrack, alvo: AlvoDoCodificador): Promise<void>;
  configurar(alvo: AlvoDoCodificador): void;
  /** Troca a captura sem derrubar ninguém: o próximo quadro é IDR. */
  trocarFonte(track: MediaStreamTrack): void;
  /** `senders`: a plateia vista pelo worker — a janela de coalescência escala por ela. */
  pedirChave(motivo?: string, senders?: number): void;
  /** Fila dos senders, em quadros: acima do tolerado, pula quadro de captura. */
  definirAtraso(quadros: number): void;
  estatisticas(): EstatisticasDoCodificador;
  /**
   * Tamanho da captura, quando quem codifica sabe melhor que a trilha — o
   * codificador externo captura sozinho, e a trilha que o transporte recebe
   * não é a imagem. `null` = use a trilha.
   */
  fonte(): { readonly width: number; readonly height: number } | null;
  parar(): void;
}

export type DepsDoCodificador = {
  /** Um quadro codificado, para o worker de injeção. */
  readonly entregar: (chunk: ChunkInjetado, transferir: Transferable[]) => void;
  /** A cada quadro capturado, codificado ou não: o relógio da isca. */
  readonly aoCapturar: () => void;
  /** O tamanho da captura mudou (ver `fonte()`): o alvo precisa ser refeito. */
  readonly aoMudarFonte: () => void;
};
