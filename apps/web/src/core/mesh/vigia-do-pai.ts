/**
 * O filho de repasse (ADR 0031) decide quando a imagem do pai serve — e
 * quando deixou de servir — pelo que DECODIFICA, não pelo que chega.
 *
 * Relato de 02/10 (espectador, Chrome 154): ligação ok (RTT 14–21 ms), zero
 * perda, e a imagem minguando de 16 para 5 quadros por segundo até o preto;
 * noutra sessão do mesmo usuário, 0 quadros e o navegador pedindo quadro-chave
 * 5 vezes por segundo. Os dois sintomas cabem no repasse:
 *
 * - **Troca cedo demais.** O filho trocava a imagem para a do pai no primeiro
 *   PACOTE (`unmute`) e já mandava `com-pai`: o anfitrião parava de mandar
 *   direto e a tela ficava preta até o pai entregar um quadro decodificável —
 *   ou para sempre, se não entregasse. Agora só troca depois do primeiro quadro
 *   DECODIFICADO (`pronto`).
 * - **Pai que entrega a conta-gotas.** A vigia de antes só olhava `mute`, que
 *   o navegador só dispara quando os pacotes param de vez; um fio de pacotes a
 *   mantinha calada enquanto a imagem virava slide. Agora o filho compara
 *   os quadros que decodifica com os que o PAI diz ter recebido do anfitrião
 *   no mesmo intervalo: tela parada no anfitrião (poucos quadros na origem)
 *   não acusa ninguém; o pai recebendo e o filho não, acusa.
 */
export type LeituraDoFilho = {
  /** Quadros decodificados na aresta do pai, acumulado. */
  readonly decodificados: number;
  readonly agora: number;
};

/** Leituras seguidas (≈1 s cada) com o filho bem abaixo do pai que derrubam a aresta. */
export const LEITURAS_RUINS = 3;
/** Abaixo desta fração do que o pai recebe, a aresta não está entregando. */
export const FRACAO_MINIMA = 0.5;
/** Abaixo disto de fps na origem não há o que comparar (tela parada). */
export const FPS_MINIMO_NA_ORIGEM = 5;
/** O relato do pai vale por este tempo; depois, sem referência, não se julga. */
export const VALIDADE_DO_PAI_MS = 5_000;

export class VigiaDoPai {
  private anterior: LeituraDoFilho | null = null;
  private fpsDoPai: number | null = null;
  private fpsDoPaiEm = 0;
  private ruins = 0;

  /** O pai contou quantos quadros por segundo está recebendo do anfitrião. */
  relatoDoPai(fps: number, agora: number): void {
    if (!Number.isFinite(fps) || fps < 0) return;
    this.fpsDoPai = fps;
    this.fpsDoPaiEm = agora;
  }

  /** A aresta já entregou um quadro decodificável: pode trocar a imagem. */
  static pronto(l: LeituraDoFilho): boolean {
    return l.decodificados > 0;
  }

  /**
   * Uma leitura (~1 s) do filho, já com a imagem do pai na tela. `true` =
   * a aresta não está entregando: volte ao anfitrião.
   */
  observar(l: LeituraDoFilho): boolean {
    const a = this.anterior;
    this.anterior = l;
    if (a === null || l.decodificados < a.decodificados) return false;
    const segundos = (l.agora - a.agora) / 1000;
    if (segundos <= 0) return false;
    const fpsFilho = (l.decodificados - a.decodificados) / segundos;

    const pai = this.fpsDoPai;
    const relatoValido = pai !== null && l.agora - this.fpsDoPaiEm <= VALIDADE_DO_PAI_MS;
    const ruim = relatoValido && pai >= FPS_MINIMO_NA_ORIGEM && fpsFilho < FRACAO_MINIMA * pai;
    this.ruins = ruim ? this.ruins + 1 : 0;
    return this.ruins >= LEITURAS_RUINS;
  }

  reiniciar(): void {
    this.anterior = null;
    this.fpsDoPai = null;
    this.fpsDoPaiEm = 0;
    this.ruins = 0;
  }
}
