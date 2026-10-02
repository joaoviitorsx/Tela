/**
 * O buffer circular do som do jogo no Windows (D3, PLANO-desktop §4.1): onde o
 * PCM do addon espera até o `AudioWorklet` o consumir.
 *
 * Sem DOM, sem Web Audio — só aritmética, para testar com números. O worklet
 * (`pcm-worklet.ts`) é uma casca fina em volta disto.
 *
 * Três problemas de relógio, três respostas:
 *
 * - **partida e vazio:** só começa a tocar com `alvo` quadros guardados (~60 ms),
 *   que é a folga contra um atraso do processo que entrega. Se esvazia, devolve
 *   silêncio e RE-ENCHE até o alvo antes de voltar — um estalo só, não vários;
 * - **deriva:** o relógio do WASAPI e o do `AudioContext` não são o mesmo
 *   cristal; uma hora de jogo acumula dezenas de ms. A leitura anda um pouco
 *   mais rápido ou mais devagar (até ±0,5%, inaudível) conforme o nível está
 *   acima ou abaixo do alvo, com interpolação linear — o nível converge para o
 *   alvo em vez de crescer até estourar ou secar até estalar;
 * - **estouro:** se o consumidor ficou parado (aba pausada, depuração), o que
 *   se acumulou é som velho. Passou do teto, joga fora o mais antigo e volta
 *   ao alvo: latência baixa vale mais que um trecho velho.
 *
 * Estéreo intercalado na entrada (como o addon entrega), canais separados na
 * saída (como o worklet pede).
 */
export type OpcoesDoAnel = {
  /** Capacidade em quadros por canal. */
  readonly capacidade: number;
  /** Nível-alvo em quadros: a latência que o anel acrescenta. */
  readonly alvo: number;
  /** Acima disto, descarta o mais antigo. Padrão: 3 × alvo. */
  readonly teto?: number;
};

export type EstatisticasDoAnel = {
  /** Vezes que esvaziou e voltou a se encher. */
  readonly vazios: number;
  /** Vezes que passou do teto e jogou som velho fora. */
  readonly descartes: number;
};

/** O quanto a leitura pode se afastar do ritmo normal: 0,5% é abaixo do que o ouvido nota. */
export const AJUSTE_MAXIMO_DA_TAXA = 0.005;
/** Ganho do ajuste: erro relativo do nível × isto, limitado por `AJUSTE_MAXIMO_DA_TAXA`. */
const GANHO_DO_AJUSTE = 0.02;

export class AnelPcm {
  private readonly esq: Float32Array;
  private readonly dir: Float32Array;
  private readonly capacidade: number;
  private readonly alvo: number;
  private readonly teto: number;
  /** Quadros escritos desde o início (cresce sem parar; o índice é o módulo). */
  private escrita = 0;
  /** Posição de leitura em quadros, fracionária por causa do ajuste de taxa. */
  private leitura = 0;
  private enchendo = true;
  private vazios = 0;
  private descartes = 0;

  constructor(opcoes: OpcoesDoAnel) {
    this.capacidade = opcoes.capacidade;
    this.alvo = opcoes.alvo;
    this.teto = Math.min(opcoes.teto ?? opcoes.alvo * 3, opcoes.capacidade - 2);
    if (!(this.alvo > 0) || !(this.teto > this.alvo)) throw new RangeError('alvo e teto do anel inconsistentes');
    this.esq = new Float32Array(this.capacidade);
    this.dir = new Float32Array(this.capacidade);
  }

  /** Quadros guardados, para diagnóstico e testes. */
  nivel(): number {
    return this.escrita - this.leitura;
  }

  estatisticas(): EstatisticasDoAnel {
    return { vazios: this.vazios, descartes: this.descartes };
  }

  /** Empurra estéreo intercalado (L R L R …). Um número ímpar de floats perde o último. */
  empurrar(intercalado: Float32Array): void {
    const quadros = Math.floor(intercalado.length / 2);
    for (let i = 0; i < quadros; i++) {
      const k = (this.escrita + i) % this.capacidade;
      this.esq[k] = intercalado[2 * i] ?? 0;
      this.dir[k] = intercalado[2 * i + 1] ?? 0;
    }
    this.escrita += quadros;
    if (this.nivel() > this.teto) {
      this.leitura = this.escrita - this.alvo;
      this.descartes += 1;
    }
  }

  /** Preenche `esq`/`dir` com o que há; o que falta vira silêncio. */
  puxar(esq: Float32Array, dir: Float32Array): void {
    const n = Math.min(esq.length, dir.length);
    if (this.enchendo) {
      if (this.nivel() < this.alvo) {
        esq.fill(0, 0, n);
        dir.fill(0, 0, n);
        return;
      }
      this.enchendo = false;
    }
    // Erro relativo do nível: positivo = sobra (lê mais rápido), negativo = falta.
    const erro = (this.nivel() - this.alvo) / this.alvo;
    const taxa = 1 + Math.max(-AJUSTE_MAXIMO_DA_TAXA, Math.min(AJUSTE_MAXIMO_DA_TAXA, erro * GANHO_DO_AJUSTE));

    for (let i = 0; i < n; i++) {
      const base = Math.floor(this.leitura);
      // A interpolação precisa do quadro seguinte: sem ele, é vazio.
      if (base + 1 >= this.escrita) {
        esq.fill(0, i, n);
        dir.fill(0, i, n);
        this.enchendo = true;
        this.vazios += 1;
        return;
      }
      const frac = this.leitura - base;
      const a = base % this.capacidade;
      const b = (base + 1) % this.capacidade;
      esq[i] = (this.esq[a] ?? 0) * (1 - frac) + (this.esq[b] ?? 0) * frac;
      dir[i] = (this.dir[a] ?? 0) * (1 - frac) + (this.dir[b] ?? 0) * frac;
      this.leitura += taxa;
    }
  }
}
