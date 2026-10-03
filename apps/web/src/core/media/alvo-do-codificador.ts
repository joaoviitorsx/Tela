import type { CodecDaSala } from './codec-da-sala.js';
import type { PerfilH264 } from './perfil-h264.js';
import {
  CONTENT_HINT_POR_PRIORIDADE,
  FRAMERATE_POR_PRIORIDADE,
  type EncodingPreset,
  type Prioridade,
  tetoDeBitrate,
} from '@tela/shared';

/**
 * O que o CODIFICADOR ÚNICO deve produzir (D0b, `docs/desktop/D0b-um-encode-n-envios.md`).
 *
 * No caminho de hoje, cada `RTCRtpSender` tem o próprio encoder e o WebRTC lhe
 * entrega `min(BWE, maxBitrate)` pacote a pacote. Com um encoder só para N
 * envios, ninguém faz isso por ele: o alvo é calculado aqui, com a MESMA regra
 * da topologia (`MeshTopology.effectiveBitrate`), e um freio a mais.
 *
 * Pura: degrau, orçamento, prioridade e medidas entram; resolução, fps e bitrate
 * saem. Sem DOM, testável.
 */
export type AlvoDoCodificador = {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate: number;
  /**
   * O freio da estimativa cortou o bitrate abaixo do orçamento. O transporte
   * reporta isso como `bandwidth`, que é o sinal que leva a malha a descer o
   * DEGRAU — sem ele, a resolução ficava alta com bits de menos, a imagem
   * borrada da ADR 0015.
   */
  readonly limitadoPelaEstimativa: boolean;
  /** O piso de perfil H.264 da sala (`perfil-h264.ts`). */
  readonly perfil: PerfilH264;
  /**
   * O `contentHint` do encoder: `motion` (fluidez) ou `detail` (nitidez,
   * ADR 0015). No caminho "um encode" o encoder lê os quadros direto — o
   * `contentHint` da TRILHA não chega a ele, só este.
   */
  readonly conteudo: 'motion' | 'detail';
  /**
   * Camadas temporais: `2` (L1T2) dá a válvula por espectador (ADR 0034) —
   * quem fica para trás pula a camada 1 e assiste a meia taxa, sem congelar.
   */
  readonly camadas: 1 | 2;
  /** O codec da sala (ADR 0035): H.264, ou AV1 com a sala inteira decodificando. */
  readonly codec: CodecDaSala;
};

export type EntradaDoAlvo = {
  readonly preset: EncodingPreset;
  /** Orçamento de vídeo POR caminho, da malha de banda. `null` = sem medição. */
  readonly orcamento: number | null;
  readonly prioridade: Prioridade;
  /** O piso de perfil da sala; ausente = Baseline, o que todo receptor decodifica. */
  readonly perfil?: PerfilH264;
  /** Camadas temporais pedidas (ADR 0034); ausente = 1. */
  readonly camadas?: 1 | 2;
  /** Codec da sala (ADR 0035); ausente = H.264. */
  readonly codec?: CodecDaSala;
  /** Tamanho que a captura entrega. O codificador só tira pixel, não cria. */
  readonly fonte: { readonly width: number; readonly height: number } | null;
  /**
   * A pior estimativa de banda medida agora, em bits/s. `null` sem leitura.
   *
   * É o freio que o encoder do WebRTC teria pacote a pacote e o único não tem:
   * entre duas decisões da malha (que suaviza por segundos), um caminho que
   * encolheu não pode receber o bitrate de antes.
   */
  readonly piorEstimativa: number | null;
};

/** Abaixo disto não há vídeo que preste (mesmo piso da malha de banda). */
export const BITRATE_MINIMO = 300_000;
/** Fração da estimativa medida que o freio rápido deixa usar. */
export const FOLGA_DA_ESTIMATIVA = 0.85;

export function alvoDoCodificador(e: EntradaDoAlvo): AlvoDoCodificador {
  const fps = Math.min(e.preset.main.maxFramerate, FRAMERATE_POR_PRIORIDADE[e.prioridade]);

  /*
    Mesma escala do `escalaPara` da topologia: o MAIOR dos dois fatores manda,
    e nunca abaixo de 1 — fonte menor que o degrau sai no tamanho da fonte.
    Dimensões pares: H.264 4:2:0 exige.
  */
  let width = e.preset.width;
  let height = e.preset.height;
  if (e.fonte !== null && e.fonte.width > 0 && e.fonte.height > 0) {
    const escala = Math.max(1, e.fonte.width / e.preset.width, e.fonte.height / e.preset.height);
    width = e.fonte.width / escala;
    height = e.fonte.height / escala;
  }
  width = Math.max(2, Math.round(width / 2) * 2);
  height = Math.max(2, Math.round(height / 2) * 2);

  /*
    A regra da topologia (ADR 0017/0018): sem medição, o nominal calibrado —
    aqui é bitrate de ENCODER, que empurra, não teto que só limita; com
    medição, o orçamento até o teto útil de bits por pixel.
  */
  const teto = tetoDeBitrate(e.preset.width, e.preset.height, fps);
  let bitrate = e.orcamento === null ? e.preset.main.maxBitrate : Math.min(e.orcamento, teto);
  let limitadoPelaEstimativa = false;
  if (e.piorEstimativa !== null && e.piorEstimativa > 0 && e.piorEstimativa * FOLGA_DA_ESTIMATIVA < bitrate) {
    bitrate = e.piorEstimativa * FOLGA_DA_ESTIMATIVA;
    limitadoPelaEstimativa = true;
  }
  return {
    width,
    height,
    fps,
    bitrate: Math.max(BITRATE_MINIMO, Math.round(bitrate)),
    limitadoPelaEstimativa,
    perfil: e.perfil ?? 'baseline',
    conteudo: CONTENT_HINT_POR_PRIORIDADE[e.prioridade],
    camadas: e.camadas ?? 1,
    codec: e.codec ?? 'h264',
  };
}
