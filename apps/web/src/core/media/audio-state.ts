import type { AudioStats } from './audio-stats.js';

/**
 * O que o produto pode AFIRMAR sobre o som, e nada além (TELA-007, §6.9).
 *
 * # Por que estados separados
 *
 * "Não tem som" tem pelo menos seis causas com ações opostas: não havia fonte,
 * a fonte acabou, o navegador bloqueou a reprodução, o usuário silenciou, a
 * rede está comendo pacotes, ou o jogo está simplesmente em silêncio. Um
 * booleano `hasAudio` respondia só a primeira.
 *
 * # Silêncio não é defeito
 *
 * Menu de pausa, cutscene sem trilha e fala entre rodadas são silêncio de
 * verdade. `sem-sinal` só é afirmado depois de `SILENCIO_AVISO_MS` contínuos
 * abaixo de `NIVEL_SILENCIO` — e só quando o nível foi MEDIDO. Nível ausente
 * não sustenta a afirmação e zera a contagem.
 *
 * # Perda com histerese
 *
 * Entrar exige amostras seguidas acima do limiar, sair exige mais amostras
 * seguidas abaixo de um limiar menor. Sem isso o aviso piscaria a cada rajada.
 */
export type EstadoAudio =
  /** Esta sessão não tem trilha de áudio. */
  | 'sem-fonte'
  /** Havia trilha, e ela terminou. */
  | 'encerrada'
  /** Espectador: o navegador não deixou tocar até alguém clicar. */
  | 'bloqueado'
  /** Silêncio escolhido: volume zero de quem transmite, mudo de quem assiste. */
  | 'mudo'
  /** O decoder está inventando uma fração perceptível do som. */
  | 'perda'
  /** A fonte está viva e não sai nada dela há tempo suficiente. */
  | 'sem-sinal'
  | 'transmitindo'
  /** Há trilha, e ainda não há medida que permita dizer mais. */
  | 'desconhecido';

export type EntradaAudio = {
  readonly trilha: 'ausente' | 'viva' | 'encerrada';
  readonly mudoIntencional: boolean;
  readonly reproducaoBloqueada: boolean;
  readonly stats: AudioStats | null;
  readonly agora: number;
};

/** ~-60 dBFS em RMS linear. Abaixo disto é silêncio para qualquer ouvido. */
export const NIVEL_SILENCIO = 0.001;
export const SILENCIO_AVISO_MS = 20_000;
/** 5% do som inventado já é audível como "picotado". */
export const OCULTACAO_ENTRA = 0.05;
export const OCULTACAO_SAI = 0.02;
export const AMOSTRAS_PARA_ENTRAR = 3;
export const AMOSTRAS_PARA_SAIR = 5;

export class ClassificadorDeAudio {
  private silencioDesde: number | null = null;
  private emPerda = false;
  private seguidas = 0;

  reiniciar(): void {
    this.silencioDesde = null;
    this.emPerda = false;
    this.seguidas = 0;
  }

  observar(e: EntradaAudio): EstadoAudio {
    this.acompanharSilencio(e);
    this.acompanharPerda(e.stats);

    if (e.trilha === 'encerrada') return 'encerrada';
    if (e.trilha === 'ausente') return 'sem-fonte';
    if (e.reproducaoBloqueada) return 'bloqueado';
    if (e.mudoIntencional) return 'mudo';
    if (this.emPerda) return 'perda';
    if (this.silencioDesde !== null && e.agora - this.silencioDesde >= SILENCIO_AVISO_MS) {
      return 'sem-sinal';
    }
    const s = e.stats;
    if (s === null || (s.bitrateBps === null && s.nivel === null)) return 'desconhecido';
    return 'transmitindo';
  }

  private acompanharSilencio(e: EntradaAudio): void {
    const nivel = e.stats?.nivel ?? null;
    // Silêncio escolhido não conta como silêncio da fonte, nem começa o relógio.
    if (nivel === null || e.mudoIntencional || e.trilha !== 'viva') {
      this.silencioDesde = null;
      return;
    }
    if (nivel >= NIVEL_SILENCIO) this.silencioDesde = null;
    else this.silencioDesde ??= e.agora;
  }

  private acompanharPerda(stats: AudioStats | null): void {
    const oc = stats?.ocultacao ?? null;
    // Sem medida, a contagem recomeça — e o estado atual se mantém.
    if (oc === null) {
      this.seguidas = 0;
      return;
    }
    const contra = this.emPerda ? oc < OCULTACAO_SAI : oc > OCULTACAO_ENTRA;
    this.seguidas = contra ? this.seguidas + 1 : 0;
    const precisa = this.emPerda ? AMOSTRAS_PARA_SAIR : AMOSTRAS_PARA_ENTRAR;
    if (this.seguidas >= precisa) {
      this.emPerda = !this.emPerda;
      this.seguidas = 0;
    }
  }
}
