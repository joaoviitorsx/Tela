/**
 * Quem codifica: a GPU ou a CPU — e o que fazer quando a GPU falha no meio da
 * transmissão (D9, `docs/desktop/D9-gpu-windows.md`).
 *
 * # As três preferências do WebCodecs
 *
 * - `prefer-hardware`: só o encoder da GPU (Media Foundation no Windows:
 *   NVENC, AMF, Quick Sync). Sem ele, o `configure` falha — o Chromium NÃO
 *   cai em software calado. É isso que permite dizer "hardware" sem chutar.
 * - `no-preference`: o Chromium tenta a GPU e cai em software sozinho se ela
 *   não aceitar. Funciona, mas não diz qual dos dois ficou.
 * - `prefer-software`: OpenH264, na CPU.
 *
 * # A política
 *
 * ```text
 *            sonda diz hardware?
 *          sim │           │ não / não sabe
 *              ▼           ▼
 *      prefer-hardware   no-preference        (o de hoje: nunca pior)
 *              │ erro ou trava
 *              ▼
 *      prefer-software ──(30 s, depois 60 s)──► volta ao modo inicial
 *              ▲                                  │ falhou de novo
 *              └──────────────────────────────────┘
 *      na 3ª queda fica em software até o fim da transmissão
 * ```
 *
 * Por que voltar: a causa mais comum de um encoder de GPU morrer no meio é o
 * driver reiniciar (TDR no Windows), e depois dele a GPU volta. Ficar em
 * software para sempre custaria ~1 núcleo ao jogo pelo resto da noite.
 * Por que desistir: um driver que falha toda vez não pode congelar a
 * transmissão de 30 em 30 segundos.
 *
 * O que NÃO derruba para software: o encoder de GPU estar LENTO. Isso é a GPU
 * disputada pelo jogo, e mandar o trabalho para a CPU tiraria do jogo o que
 * ele mais precisa. Lentidão continua sendo o sinal `cpu` do transporte, que
 * leva a malha a descer o degrau — menos pixel, no mesmo encoder.
 *
 * Pura: sem DOM, sem WebCodecs, relógio injetado nas chamadas.
 */

export type Aceleracao = 'prefer-hardware' | 'no-preference' | 'prefer-software';
export type ClasseDoEncoder = 'hardware' | 'software' | 'desconhecido';
export type MotivoDaQueda = 'erro' | 'travou';

/** Espera antes da 1ª volta à GPU; dobra a cada queda. */
export const ESPERA_PARA_VOLTAR_MS = 30_000;
/** Quedas toleradas: na seguinte, software até o fim da transmissão. */
export const VOLTAS_PERMITIDAS = 2;

export class AceleracaoDoCodificador {
  private inicial: Aceleracao = 'no-preference';
  private atual: Aceleracao = 'no-preference';
  private suportaHardware: boolean | null = null;
  private quedas = 0;
  private ultimaQueda = -Infinity;
  private motivo: MotivoDaQueda | null = null;

  /**
   * @param preferirHardware pedir a GPU explicitamente quando a sonda diz que
   *   há. `false` mantém o `no-preference` de sempre como modo inicial.
   */
  constructor(private readonly preferirHardware: boolean) {}

  /**
   * O resultado de `isConfigSupported({ hardwareAcceleration: 'prefer-hardware' })`
   * para o alvo inicial: `null` quando a sonda nem respondeu.
   */
  comecar(suportaHardware: boolean | null): Aceleracao {
    this.suportaHardware = suportaHardware;
    this.inicial = this.preferirHardware && suportaHardware === true ? 'prefer-hardware' : 'no-preference';
    this.atual = this.quedas > 0 ? 'prefer-software' : this.inicial;
    return this.atual;
  }

  get modo(): Aceleracao {
    return this.atual;
  }

  /**
   * O encoder morreu ou travou. Devolve o modo do próximo encoder e se vale
   * recriá-lo JÁ: em software a falha não é da GPU, e recriar na hora poderia
   * virar laço — ele volta na próxima reconfiguração, como antes.
   */
  falhou(motivo: MotivoDaQueda, agora: number): { readonly modo: Aceleracao; readonly recriarJa: boolean } {
    // Só é queda da GPU se a GPU podia estar codificando. `no-preference` com a
    // sonda dizendo "sem hardware" já é software (o Linux de sempre).
    const podiaSerGpu =
      this.atual === 'prefer-hardware' || (this.atual === 'no-preference' && this.suportaHardware !== false);
    if (!podiaSerGpu) return { modo: this.atual, recriarJa: false };
    this.quedas += 1;
    this.ultimaQueda = agora;
    this.motivo = motivo;
    this.atual = 'prefer-software';
    return { modo: this.atual, recriarJa: true };
  }

  /**
   * Chamado com folga (a cada reconfiguração, ~1 Hz). `true` quando é hora de
   * tentar de novo o modo inicial — e já passa a valer.
   */
  voltar(agora: number): boolean {
    if (this.atual !== 'prefer-software' || this.quedas === 0 || this.quedas > VOLTAS_PERMITIDAS) return false;
    const espera = ESPERA_PARA_VOLTAR_MS * 2 ** (this.quedas - 1);
    if (agora - this.ultimaQueda < espera) return false;
    this.atual = this.inicial;
    return true;
  }

  /** O que se pode AFIRMAR sobre quem codifica agora. */
  classe(): ClasseDoEncoder {
    if (this.atual === 'prefer-hardware') return 'hardware';
    if (this.atual === 'prefer-software') return 'software';
    // `no-preference`: só é certo quando a GPU disse que não aceita.
    return this.suportaHardware === false ? 'software' : 'desconhecido';
  }

  /** Para o console: `WebCodecs·hardware`, `WebCodecs·software`, `WebCodecs·software·GPU caiu`, `WebCodecs`. */
  rotulo(): string {
    const classe = this.classe();
    if (classe === 'desconhecido') return 'WebCodecs';
    const caiu = classe === 'software' && this.quedas > 0 ? `·GPU ${this.motivo === 'travou' ? 'travou' : 'caiu'}` : '';
    return `WebCodecs·${classe}${caiu}`;
  }

  /** Quantas vezes a GPU falhou nesta transmissão — diagnóstico. */
  get quedasDaGpu(): number {
    return this.quedas;
  }
}
