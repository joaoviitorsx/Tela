import { PRESET_720P30, type EncodingPreset } from '@tela/shared';

/**
 * Decide o teto de upload do vídeo, com amortecimento.
 *
 * # O erro que este arquivo existe para não repetir
 *
 * A primeira versão lia `availableOutgoingBitrate` e aplicava 75% dele
 * diretamente, uma vez por segundo. O estimador oscila por natureza — ele
 * sobe, sonda, recua — então o encoder recebia um alvo diferente a cada
 * segundo e nunca chegava a estabilizar. O resultado que os usuários
 * relataram foi exatamente o que uma malha de controle sem amortecimento
 * produz: travamento e instabilidade.
 *
 * Uma malha que reage mais rápido do que o sistema assenta oscila. Sempre.
 *
 * Três defesas, nesta ordem:
 *
 * 1. **Aquecimento.** Nos primeiros segundos o controle de congestionamento
 *    ainda está sondando e a estimativa não vale nada. Não se decide nada
 *    com ela.
 * 2. **Suavização.** Média móvel exponencial, para que um vale isolado não
 *    vire uma queda de qualidade.
 * 3. **Histerese.** Só muda o teto quando o alvo se afasta o bastante do que
 *    já está aplicado. Ajuste pequeno não compensa o custo de reconfigurar o
 *    encoder.
 *
 * E um piso: nunca abaixo do menor preset. Uma estimativa ruim não pode
 * estrangular a transmissão até o nada — é melhor deixar o próprio WebRTC
 * descartar pacotes do que desligar a imagem por precaução.
 */

/** Fração da banda estimada que o vídeo pode ocupar. O resto é folga. */
export const UPLINK_SHARE = 0.75;

/** Peso da leitura nova na média móvel. Baixo = mais lento, mais estável. */
const SUAVIZACAO = 0.25;

/** Só reconfigura o encoder se o alvo mudar mais que isto. */
const HISTERESE = 0.25;

/** Leituras ignoradas no início, enquanto o estimador ainda sonda. */
const AQUECIMENTO_AMOSTRAS = 8;

/** Nunca abaixo do menor preset: teto que estrangula é pior que teto nenhum. */
const PISO_BPS = PRESET_720P30.main.maxBitrate;

export class UplinkGovernor {
  private media: number | null = null;
  private aplicado: number | null = null;
  private amostras = 0;

  reset(): void {
    this.media = null;
    this.aplicado = null;
    this.amostras = 0;
  }

  /** Teto atualmente aplicado, ou `null` se nenhum. */
  get ceiling(): number | null {
    return this.aplicado;
  }

  /**
   * Recebe uma leitura de banda disponível e devolve o teto a aplicar, ou
   * `null` quando nada deve mudar — que é o caso na maioria das leituras.
   */
  observe(availableBps: number | null, preset: EncodingPreset): number | null {
    if (availableBps === null || !Number.isFinite(availableBps) || availableBps <= 0) {
      return null;
    }

    this.amostras += 1;
    this.media = this.media === null ? availableBps : this.media + SUAVIZACAO * (availableBps - this.media);

    // Durante o aquecimento acumula a média, mas não decide nada com ela.
    if (this.amostras <= AQUECIMENTO_AMOSTRAS) return null;

    const alvo = Math.max(PISO_BPS, Math.round(this.media * UPLINK_SHARE));

    // Teto acima do que o preset já pede não restringe nada: aplicar seria
    // reconfigurar o encoder para não mudar coisa alguma.
    if (alvo >= preset.main.maxBitrate) {
      if (this.aplicado === null) return null;
      this.aplicado = null;
      return preset.main.maxBitrate;
    }

    if (this.aplicado !== null) {
      const variacao = Math.abs(alvo - this.aplicado) / this.aplicado;
      if (variacao < HISTERESE) return null;
    }

    this.aplicado = alvo;
    return alvo;
  }
}
