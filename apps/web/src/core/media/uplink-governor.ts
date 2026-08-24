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
 * 3. **Histerese, em DOIS eixos.** No valor: só muda o teto quando o alvo se
 *    afasta o bastante do que já está aplicado. E na FRONTEIRA: entrar e sair
 *    do regime "com teto" usa limiares diferentes.
 *
 *    O segundo eixo foi um defeito real. Com um limiar só, qualquer banda
 *    cuja média caísse perto de `maxBitrate / UPLINK_SHARE` — 10,67 Mbps no
 *    1080p60 — fazia o governador aplicar e soltar alternadamente, cerca de
 *    uma vez por segundo, para sempre. Os tetos aplicados diferiam do preset
 *    em menos de 1%: a histerese de valor existia justamente para impedir
 *    isso, mas o ramo de soltar zerava o estado dela antes de ser consultada.
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

/**
 * Banda morta em volta do teto do preset — gatilho de Schmitt.
 *
 * Só passa a limitar quando o alvo cai claramente ABAIXO do que o preset já
 * pede, e só larga o teto quando ele sobe claramente ACIMA. Os dois limiares
 * precisam ser diferentes: iguais, a leitura oscilando em cima do ponto de
 * troca alterna os dois regimes indefinidamente.
 */
const ENTRA_ABAIXO_DE = 0.9;
const SOLTA_ACIMA_DE = 1.15;

/** Leituras ignoradas no início, enquanto o estimador ainda sonda. */
const AQUECIMENTO_AMOSTRAS = 8;

/** Nunca abaixo do menor preset: teto que estrangula é pior que teto nenhum. */
const PISO_BPS = PRESET_720P30.main.maxBitrate;

/**
 * `null` = não mexa. `{ bps: number }` = aplique. `{ bps: null }` = solte.
 */
export type DecisaoTeto = { readonly bps: number | null } | null;

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
   * Recebe uma leitura de banda disponível e decide o que fazer com o teto.
   *
   * `null` significa "não mexa" — o caso da esmagadora maioria das leituras.
   * `{ bps }` aplica; `{ bps: null }` remove o teto e devolve o comando ao
   * preset.
   *
   * A distinção entre "não mexa" e "remova" importa: antes as duas coisas
   * eram o mesmo retorno, e soltar o teto gravava `preset.main.maxBitrate`
   * como se fosse um teto de verdade. O número do preset ANTIGO ficava
   * grudado, então subir a qualidade no seletor não subia o bitrate — a UI
   * dizia 1080p60 e o encoder continuava preso em 4 Mbps.
   *
   * `availableBps` deve chegar POR ESPECTADOR. Em mesh o teto vira
   * `maxBitrate` de cada sender, e cada espectador recebe uma cópia inteira.
   */
  observe(availableBps: number | null, preset: EncodingPreset): DecisaoTeto {
    if (availableBps === null || !Number.isFinite(availableBps) || availableBps <= 0) {
      return null;
    }

    this.amostras += 1;
    this.media = this.media === null ? availableBps : this.media + SUAVIZACAO * (availableBps - this.media);

    // Durante o aquecimento acumula a média, mas não decide nada com ela.
    if (this.amostras <= AQUECIMENTO_AMOSTRAS) return null;

    const alvo = Math.max(PISO_BPS, Math.round(this.media * UPLINK_SHARE));
    const tetoDoPreset = preset.main.maxBitrate;

    if (this.aplicado === null) {
      // Sem teto. Só assume o controle se houver o que restringir de fato:
      // um teto igual ao que o preset já pede reconfigura o encoder à toa.
      if (alvo >= tetoDoPreset * ENTRA_ABAIXO_DE) return null;
      this.aplicado = alvo;
      return { bps: alvo };
    }

    // Com teto. Só devolve o controle quando a banda sobra com folga.
    if (alvo >= tetoDoPreset * SOLTA_ACIMA_DE) {
      this.aplicado = null;
      return { bps: null };
    }

    const variacao = Math.abs(alvo - this.aplicado) / this.aplicado;
    if (variacao < HISTERESE) return null;

    this.aplicado = alvo;
    return { bps: alvo };
  }
}
