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
const CAPACIDADE_EVENTOS = 64;
let proximoIdLocal = 0;

/** Fallback dos testes; o container injeta UUID criptográfico no navegador. */
export function idLocal(): string {
  proximoIdLocal += 1;
  return `local-${proximoIdLocal}`;
}

export type EtapaDiagnostico =
  | 'capture' | 'signaling' | 'turn' | 'ice' | 'dtls'
  | 'rtp' | 'decode' | 'render' | 'audio' | 'video' | 'session';

/** Códigos fechados: nunca aceitar texto de erro, SDP ou payload do servidor. */
export type CodigoDiagnostico =
  | 'START' | 'ATTEMPT' | 'CAPTURE_READY' | 'CONNECTING' | 'LIVE'
  | 'WATCHING' | 'RECONNECTING' | 'OFFLINE' | 'FULL'
  | 'NO_ROUTE' | 'SIGNALING_UNAVAILABLE' | 'MEDIA_TIMEOUT'
  | 'RELAY_AVAILABLE' | 'RELAY_UNAVAILABLE' | 'RELAY_NOT_CONFIGURED'
  | 'CAPTURE_DENIED' | 'CAPTURE_UNSUPPORTED' | 'CAPTURE_ENDED'
  | 'SLUG_TAKEN' | 'SLUG_INVALID' | 'RATE_LIMITED'
  | 'TRANSPORT_FAILED' | 'USER_STOPPED' | 'ENDED';

export type EventoDiagnostico = {
  readonly t: number;
  readonly tentativaId: string;
  readonly etapa: EtapaDiagnostico;
  readonly codigo: CodigoDiagnostico;
};

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
  readonly decodeMs: number | null;
  readonly congelamentos: number | null;
  readonly perdidos: number | null;
  readonly keyframesPedidos: number | null;
};

export type Diagnostico = {
  readonly versao: 2;
  readonly versaoApp: string | null;
  readonly sessaoId: string;
  readonly tentativaId: string;
  readonly papel: 'transmissor' | 'espectador';
  readonly quando: string;
  readonly navegador: string;
  readonly decoder: string | null;
  readonly encoder: string | null;
  /** `null` significa que esta etapa ainda não foi observada. */
  readonly etapas: Readonly<Record<EtapaDiagnostico, CodigoDiagnostico | null>>;
  readonly eventos: readonly EventoDiagnostico[];
  readonly amostras: readonly AmostraDiagnostico[];
};

function identificador(valor: string): string {
  return valor.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
}

/** Só família e versão principal; o user agent bruto pode carregar dados locais. */
function navegadorSeguro(valor: string): string {
  const conhecido = /(Edg|Firefox|Chrome|Version)\/(\d{1,3})/.exec(valor);
  return conhecido === null ? 'desconhecido' : `${conhecido[1]}/${conhecido[2]}`;
}

function implementacaoSegura(valor: string | null): string | null {
  if (valor === null) return null;
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(valor)) return null;
  return /^[a-zA-Z][a-zA-Z0-9 _.-]{0,63}$/.test(valor) ? valor : null;
}

function etapasVazias(): Record<EtapaDiagnostico, CodigoDiagnostico | null> {
  return {
    capture: null, signaling: null, turn: null, ice: null, dtls: null,
    rtp: null, decode: null, render: null, audio: null, video: null,
    session: null,
  };
}

/**
 * Anel de tamanho fixo. Uma transmissão longa não pode virar um vazamento de
 * memória na máquina que está rodando o jogo.
 */
export class Diario {
  private readonly amostras: AmostraDiagnostico[] = [];
  private readonly eventos: EventoDiagnostico[] = [];
  private etapas = etapasVazias();
  private encoder: string | null = null;
  private decoder: string | null = null;
  private sessaoId = 'unknown';
  private tentativaId = 'unknown';
  private versaoApp: string | null = null;
  private quando = '';
  private congelado: Omit<Diagnostico, 'quando' | 'navegador'> | null = null;

  constructor(private readonly papel: 'transmissor' | 'espectador') {}

  iniciar(sessaoId: string, versaoApp: string | null): void {
    this.limpar();
    this.sessaoId = identificador(sessaoId);
    this.quando = new Date().toISOString();
    this.versaoApp = versaoApp !== null && /^[a-zA-Z0-9._+-]{1,64}$/.test(versaoApp)
      ? versaoApp : null;
  }

  tentativa(id: string, agora: number): void {
    this.tentativaId = identificador(id);
    this.evento('session', 'ATTEMPT', agora);
  }

  evento(etapa: EtapaDiagnostico, codigo: CodigoDiagnostico, agora: number): void {
    if (this.congelado !== null) return;
    this.etapas[etapa] = codigo;
    this.eventos.push({
      t: Math.round(agora), tentativaId: this.tentativaId, etapa, codigo,
    });
    if (this.eventos.length > CAPACIDADE_EVENTOS) this.eventos.shift();
  }

  registrar(stats: MediaStats, agora: number): void {
    if (this.congelado !== null) return;
    if (stats.encoderImplementation !== null) {
      this.encoder = implementacaoSegura(stats.encoderImplementation);
    }
    if (stats.recepcao?.decoder != null) {
      this.decoder = implementacaoSegura(stats.recepcao.decoder);
    }

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
      decodeMs:
        stats.recepcao?.decodeMs == null ? null : Number(stats.recepcao.decodeMs.toFixed(1)),
      congelamentos: stats.recepcao?.congelamentos ?? null,
      perdidos: stats.recepcao?.pacotesPerdidos ?? null,
      keyframesPedidos: stats.recepcao?.pedidosDeKeyframe ?? null,
    });

    if (this.amostras.length > CAPACIDADE) this.amostras.shift();
  }

  limpar(): void {
    this.amostras.length = 0;
    this.eventos.length = 0;
    this.etapas = etapasVazias();
    this.encoder = null;
    this.decoder = null;
    this.sessaoId = 'unknown';
    this.tentativaId = 'unknown';
    this.versaoApp = null;
    this.quando = '';
    this.congelado = null;
  }

  get vazio(): boolean {
    return this.amostras.length === 0 && this.eventos.length === 0 && this.congelado === null;
  }

  /** Congela antes da liberação assíncrona de mídia e signaling. */
  congelar(): void {
    if (this.congelado !== null) return;
    this.congelado = this.dados();
  }

  private dados(): Omit<Diagnostico, 'quando' | 'navegador'> {
    return {
      versao: 2,
      versaoApp: this.versaoApp,
      sessaoId: this.sessaoId,
      tentativaId: this.tentativaId,
      papel: this.papel,
      decoder: this.decoder,
      encoder: this.encoder,
      etapas: { ...this.etapas },
      eventos: [...this.eventos],
      amostras: [...this.amostras],
    };
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
      ...(this.congelado ?? this.dados()),
      quando: this.quando,
      navegador: navegadorSeguro(navegador),
    };
  }
}
