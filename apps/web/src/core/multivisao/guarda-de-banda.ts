import type { MotivoDaPausa } from './estado.js';

/**
 * Quando a secundária tem de sair da frente (ADR 0032 §7).
 *
 * A PiP custa a banda de uma transmissão inteira (R5: o quadro é o mesmo
 * para todos). Se quem assiste não aguenta as duas, a adaptação coletiva
 * derrubaria um degrau da SALA INTEIRA dos dois canais — um espectador
 * piorando duas transmissões. A guarda troca isso por pausar a secundária
 * deste espectador.
 *
 * A entrada é a causa da lentidão de cada painel (`VigiaDeFluidez`), que já é
 * sustentada por si; a guarda ainda exige `sustentarMs` seguidos, para um
 * soluço não fechar a PiP de ninguém. Depois de um RETOMAR, `carenciaMs` sem
 * pausar: quem pediu de volta quer tentar.
 */
export class GuardaDeBanda {
  private desde: number | null = null;
  private carenciaAte = 0;

  constructor(
    private readonly sustentarMs = 4_000,
    private readonly carenciaMs = 15_000,
  ) {}

  /** A causa que manda pausar agora, ou `null`. `rede` vence: é a que a pausa resolve de fato. */
  observar(agoraMs: number, causas: readonly (MotivoDaPausa | null | undefined)[]): MotivoDaPausa | null {
    const presentes = causas.filter((c): c is MotivoDaPausa => c != null);
    if (presentes.length === 0) {
      this.desde = null;
      return null;
    }
    this.desde ??= agoraMs;
    if (agoraMs < this.carenciaAte || agoraMs - this.desde < this.sustentarMs) return null;
    return presentes.includes('rede') ? 'rede' : 'decodificacao';
  }

  retomou(agoraMs: number): void {
    this.desde = null;
    this.carenciaAte = agoraMs + this.carenciaMs;
  }
}
