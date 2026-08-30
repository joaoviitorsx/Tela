import type { MediaStats } from '../ports/media-transport.js';

/**
 * A linha do tempo das estatísticas, para o usuário poder MANDAR em vez de
 * descrever.
 *
 * # Por que isto existe
 *
 * O produto tem 296 testes, 1200 cenários simulados e um E2E em browser real —
 * e zero dado de uma transmissão de verdade. Quando alguém relata "está ruim",
 * o ciclo é: adivinhar, pedir para a pessoa olhar um número na tela, ouvir a
 * descrição dela, adivinhar de novo. Isso já fez consertar a coisa errada mais
 * de uma vez.
 *
 * Um relato de "cerca de um segundo de atraso" num caminho de 58ms é
 * indiagnosticável assim: os ~940ms que faltam podem estar no encoder, no
 * jitter buffer, na fila do roteador ou no decoder, e sem a série temporal não
 * há como saber qual.
 *
 * Isto não é telemetria. Nada sai da máquina sozinho — é um botão que copia
 * para a área de transferência, e a pessoa decide se manda.
 */

/** Dois minutos a uma amostra por segundo. Suficiente para pegar um episódio. */
const CAPACIDADE = 120;

/** Uma linha da série. Campos ausentes viram `null`, nunca zero. */
export type AmostraDiagnostico = {
  readonly t: number;
  readonly fps: number;
  readonly largura: number;
  readonly altura: number;
  readonly kbps: number;
  readonly rttMs: number;
  readonly bpp: number;
  readonly qp: number | null;
  readonly msPorQuadro: number | null;
  readonly limitador: string;
  readonly orcamentoKbps: number | null;
  /** Só no espectador. */
  readonly jitterMs: number | null;
  readonly processamentoMs: number | null;
  readonly congelamentos: number | null;
  readonly perdidos: number | null;
  readonly keyframesPedidos: number | null;
};

export type Diagnostico = {
  readonly versao: 1;
  readonly papel: 'transmissor' | 'espectador';
  readonly quando: string;
  readonly navegador: string;
  readonly decoder: string | null;
  readonly encoder: string | null;
  readonly amostras: readonly AmostraDiagnostico[];
};

/**
 * Anel de tamanho fixo. Uma transmissão longa não pode virar um vazamento de
 * memória na máquina que está rodando o jogo.
 */
export class Diario {
  private readonly amostras: AmostraDiagnostico[] = [];
  private encoder: string | null = null;
  private decoder: string | null = null;

  constructor(private readonly papel: 'transmissor' | 'espectador') {}

  registrar(stats: MediaStats, agora: number): void {
    if (stats.encoderImplementation !== null) this.encoder = stats.encoderImplementation;
    if (stats.recepcao?.decoder != null) this.decoder = stats.recepcao.decoder;

    this.amostras.push({
      t: Math.round(agora),
      fps: stats.fps,
      largura: stats.width,
      altura: stats.height,
      kbps: Math.round(stats.bitrateBps / 1000),
      rttMs: stats.rttMs,
      // Três casas: é a faixa entre 0,05 e 0,20 que importa, e ela é estreita.
      bpp: Number(stats.bpp.toFixed(3)),
      qp: stats.qp === null ? null : Math.round(stats.qp),
      msPorQuadro: stats.msPorQuadro === null ? null : Number(stats.msPorQuadro.toFixed(1)),
      limitador: stats.limitation,
      orcamentoKbps:
        stats.piorAvailableBps === null ? null : Math.round(stats.piorAvailableBps / 1000),
      jitterMs:
        stats.recepcao?.jitterBufferMs == null
          ? null
          : Math.round(stats.recepcao.jitterBufferMs),
      processamentoMs:
        stats.recepcao?.processamentoMs == null
          ? null
          : Math.round(stats.recepcao.processamentoMs),
      congelamentos: stats.recepcao?.congelamentos ?? null,
      perdidos: stats.recepcao?.pacotesPerdidos ?? null,
      keyframesPedidos: stats.recepcao?.pedidosDeKeyframe ?? null,
    });

    if (this.amostras.length > CAPACIDADE) this.amostras.shift();
  }

  limpar(): void {
    this.amostras.length = 0;
    this.encoder = null;
    this.decoder = null;
  }

  get vazio(): boolean {
    return this.amostras.length === 0;
  }

  /**
   * O relatório inteiro, pronto para virar JSON.
   *
   * `navegador` entra porque metade dos defeitos de encode dependem dele — o
   * Chrome no Linux vem com H.264 por hardware desligado por padrão, e isso
   * sozinho explica um relato de imagem ruim. Não é identificação de pessoa: é
   * a mesma string que todo servidor web já recebe em toda requisição.
   */
  relatorio(navegador: string): Diagnostico {
    return {
      versao: 1,
      papel: this.papel,
      quando: new Date().toISOString(),
      navegador,
      decoder: this.decoder,
      encoder: this.encoder,
      amostras: [...this.amostras],
    };
  }
}
