/**
 * A coreografia da abertura, em números e sem pixel nenhum.
 *
 * Todo movimento da abertura sai desta função: câmera, camadas da tela e
 * distorção do tubo. Ela é uma função pura de `t` — sem `requestAnimationFrame`,
 * sem WebGL, sem `Date.now()`. Quem chama decide de onde vem o tempo, e é por
 * isso que a linha do tempo tem teste sem navegador: `sampleIntro(0.9)` é uma
 * pergunta que se responde com `expect`.
 *
 * # De onde vêm os números
 *
 * Da especificação de coreografia, §3 (câmera), §4 (camadas) e §5 (barril).
 * Onde a §12 ("tabela consolidada") diverge das tabelas por camada, valem as
 * tabelas por camada: elas trazem o easing nomeado, e a §12 é leitura
 * arredondada de amostras. Os dois critérios de aceite que dependem disso
 * continuam valendo em qualquer das duas leituras — duração 1,80 s e
 * `k1 ≤ 0,01` em `t = 1,80`.
 *
 * # Duas decisões da especificação que não são gosto
 *
 * O dolly usa **ease-in** (§3). Acelerar na chegada é o que dá a sensação de
 * ser puxado para dentro do tubo; com ease-out a câmera desacelera ao entrar e
 * vira "câmera estacionando".
 *
 * A linha de ignição abre **primeiro na horizontal, depois na vertical** (§4).
 * Fazer os dois ao mesmo tempo vira fade genérico — o CRT liga assim.
 */

/** Duração total, em segundos. Critério de aceite: 1,80 ± 0,05. */
export const DURACAO_ABERTURA = 1.8;

/** Crossfade do canvas para o DOM, em segundos (§7). */
export const DURACAO_HANDOFF = 0.12;

/** Variante de `prefers-reduced-motion`: só o crossfade, sem timeline (§9). */
export const DURACAO_FADE = 0.3;

export type Rasgo = {
  /** Faixa horizontal deslocada, em fração da altura da tela, de cima para baixo. */
  readonly y0: number;
  readonly y1: number;
  /** Deslocamento horizontal, em fração da largura. Positivo = para a direita. */
  readonly dx: number;
};

export type QuadroAbertura = {
  readonly t: number;
  readonly camera: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** Campo de visão vertical, em graus. */
    readonly fov: number;
  };
  /**
   * L1 — a linha de ignição.
   *
   * `altura` e `largura` são frações do vidro. A especificação pede 2 px de
   * altura no trecho central: o piso em pixel é do renderizador, porque só ele
   * conhece a resolução. Aqui 0,004 é o valor nominal.
   */
  readonly ignicao: {
    readonly largura: number;
    readonly altura: number;
    readonly opacidade: number;
  };
  /** L2 — chiado. */
  readonly chiado: number;
  /** L3 — a interface dentro do tubo. Corte seco, nunca fade (§4). */
  readonly ui: number;
  /** L3 — rasgos de sintonia ativos neste instante. Amplitude decrescente. */
  readonly rasgos: readonly Rasgo[];
  /** L4 — scanlines. Período constante em ESPAÇO DE TELA, nunca em UV (§4). */
  readonly scanlines: number;
  /** L5 — posição da faixa clara, de -0,2 a 1,2. `null` quando inativa. */
  readonly roll: number | null;
  /** L6 — vinheta. */
  readonly vinheta: number;
  /** Distorção de barril do tubo (§5). */
  readonly k1: number;
};

/**
 * Solucionador de `cubic-bezier(x1, y1, x2, y2)` do CSS.
 *
 * A curva do CSS é paramétrica: `x(s)` e `y(s)` com `s` em [0,1]. Para achar
 * `y` dado `x` é preciso inverter `x(s)` primeiro — daí Newton, com bisseção
 * de reserva quando a derivada some (acontece em curvas com trecho plano, como
 * a `.55,0,1,.45` do dolly).
 */
function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const calc = (a: number, b: number, s: number) => {
    const c = 3 * a;
    const d = 3 * (b - a) - c;
    const e = 1 - c - d;
    return ((e * s + d) * s + c) * s;
  };
  const derivada = (a: number, b: number, s: number) => {
    const c = 3 * a;
    const d = 3 * (b - a) - c;
    const e = 1 - c - d;
    return (3 * e * s + 2 * d) * s + c;
  };

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    let s = x;
    for (let i = 0; i < 8; i += 1) {
      const erro = calc(x1, x2, s) - x;
      if (Math.abs(erro) < 1e-6) return calc(y1, y2, s);
      const d = derivada(x1, x2, s);
      if (Math.abs(d) < 1e-6) break;
      s -= erro / d;
    }

    let baixo = 0;
    let alto = 1;
    s = x;
    while (alto - baixo > 1e-6) {
      if (calc(x1, x2, s) < x) baixo = s;
      else alto = s;
      s = (baixo + alto) / 2;
    }
    return calc(y1, y2, s);
  };
}

const LINEAR = (x: number) => x;
/** `cubic-bezier(.16,1,.3,1)` — a ignição do tubo. */
const SAIDA_SECA = bezier(0.16, 1, 0.3, 1);
/** `cubic-bezier(.65,0,.35,1)` — o giro de 3/4 para frontal. */
const GIRO = bezier(0.65, 0, 0.35, 1);
/** `cubic-bezier(.55,0,1,.45)` — ease-IN. Ver a nota do dolly acima. */
const DOLLY = bezier(0.55, 0, 1, 0.45);
/** `cubic-bezier(.33,1,.68,1)` — o relaxamento do barril. */
const RELAXA = bezier(0.33, 1, 0.68, 1);

type Chave = readonly [t: number, valor: number, easing?: (x: number) => number];

/**
 * Amostra uma trilha de chaves em `t`, segurando os extremos.
 *
 * O easing pertence à chave de DESTINO — é a leitura da coluna "easing até
 * aqui" das tabelas da especificação. Sem easing declarado, linear.
 */
function trilha(chaves: readonly Chave[], t: number): number {
  const primeira = chaves[0];
  if (primeira === undefined) return 0;
  if (t <= primeira[0]) return primeira[1];

  for (let i = 1; i < chaves.length; i += 1) {
    const de = chaves[i - 1];
    const para = chaves[i];
    if (de === undefined || para === undefined) continue;
    if (t > para[0]) continue;

    const vao = para[0] - de[0];
    if (vao <= 0) return para[1];
    const p = (para[2] ?? LINEAR)((t - de[0]) / vao);
    // Em cima da chave, devolve o valor da chave. Interpolar com p = 1 dá
    // 0,2599999999999998 onde a especificação diz 0,26, e o critério de aceite
    // de `k1 ≤ 0,01` merece comparar com o número escrito no documento.
    return p >= 1 ? para[1] : de[1] + (para[1] - de[1]) * p;
  }

  const ultima = chaves[chaves.length - 1];
  return ultima === undefined ? 0 : ultima[1];
}

/* ─────────────────────────── §3 — câmera ─────────────────────────── */

/** Onde o giro termina e o dolly começa (§3, `t = 1,15`). */
const Z_GIRO = 2.3;

/**
 * Onde o dolly termina (§3, `t = 1,80`) — e o único número da coreografia que
 * depende da janela.
 *
 * O critério de aceite do handoff é que a troca do canvas para o DOM não
 * apareça, e isso só vale se, em `t = 1,80`, o vidro do tubo cobrir a janela
 * inteira. "Cobrir a janela" é geometria: depende da altura do vidro, do FOV
 * final e da PROPORÇÃO da janela. Num monitor 16:10 a conta dá 0,258 — que é
 * o 0,26 escrito na §3, e é uma boa notícia: a especificação e a derivação
 * concordam onde ela foi escrita.
 *
 * Num celular em pé, não. A janela é estreita, o aparelho inteiro precisa
 * caber nela em `t = 0` (senão a abertura mostra um retângulo cortado), o
 * modelo fica menor, o vidro fica menor — e a 0,26 o tubo deixa de cobrir a
 * janela. A moldura aparece no crossfade.
 *
 * Por isso `zFinal` é parâmetro: quem conhece o tamanho do vidro e a proporção
 * da janela é o renderizador, e ele passa o número para cá. A trilha continua
 * sendo uma só, e o resto da §3 continua literal.
 */
const Z_FIM_PADRAO = 0.26;

/**
 * FOV vertical no fim do dolly (§3). Exportado porque quem calcula o ponto de
 * parada da câmera é o renderizador, e ele precisa deste número — redigitá-lo
 * lá seria criar uma segunda cópia da §3.
 */
export const FOV_FINAL = 64;

const CAM_X: readonly Chave[] = [
  [0, 0.38],
  [0.5, 0.38],
  [1.15, 0, GIRO],
  [1.8, 0, DOLLY],
];
const CAM_Y: readonly Chave[] = [
  [0, 0.24],
  [0.5, 0.24],
  [1.15, 0, GIRO],
  [1.8, 0, DOLLY],
];
const CAM_Z: readonly Chave[] = [
  [0, 2.95],
  [0.5, 2.95],
  [1.15, Z_GIRO, GIRO],
  [1.8, Z_FIM_PADRAO, DOLLY],
];
const CAM_FOV: readonly Chave[] = [
  [0, 32],
  [0.5, 32],
  [1.15, 34, GIRO],
  [1.8, FOV_FINAL, DOLLY],
];

/* ───────────────────── §4 — camadas da tela ───────────────────── */

/** Horizontal primeiro (0,20→0,26), vertical depois (0,34→0,50). */
const IGN_LARGURA: readonly Chave[] = [
  [0.2, 0],
  [0.26, 1, SAIDA_SECA],
];
const IGN_ALTURA: readonly Chave[] = [
  [0.2, 0],
  [0.26, 0.004, SAIDA_SECA],
  [0.34, 0.004],
  [0.5, 1, SAIDA_SECA],
];
const IGN_OPACIDADE: readonly Chave[] = [
  [0.2, 0],
  [0.26, 1, SAIDA_SECA],
  [0.34, 1],
  [0.5, 0, SAIDA_SECA],
];

const CHIADO: readonly Chave[] = [
  [0.44, 0],
  [0.52, 1],
  [0.9, 1],
  [1.1, 0.15],
  [1.45, 0],
];

/** Corte seco em 0,90: 20 ms de subida existem só para não virar um degrau de 1 quadro. */
const UI: readonly Chave[] = [
  [0.88, 0],
  [0.9, 1],
];

const SCANLINES: readonly Chave[] = [
  [0.52, 0.35],
  [1.3, 0.35],
  [1.7, 0],
];

const VINHETA: readonly Chave[] = [
  [0.52, 0.55],
  [1.3, 0.55],
  [1.75, 0],
];

const BARRIL: readonly Chave[] = [
  [0, 0.28],
  [1.2, 0.28],
  [1.75, 0, RELAXA],
];

/** §4 — três rasgos, de amplitude decrescente. É o sinal travando. */
const RASGOS: readonly (Rasgo & { readonly t: number; readonly duracao: number })[] = [
  { t: 0.9, duracao: 0.04, y0: 0.3, y1: 0.45, dx: 0.06 },
  { t: 0.96, duracao: 0.03, y0: 0.55, y1: 0.7, dx: -0.04 },
  { t: 1.02, duracao: 0.025, y0: 0.15, y1: 0.25, dx: 0.02 },
];

/** §5 — a faixa clara desce de -0,2 a 1,2 em 2,2 s, linear, em laço. */
const ROLL_INICIO = 0.52;
const ROLL_FIM = 1.5;
const ROLL_PERIODO = 2.2;

/**
 * O estado de TODA a abertura no instante `t`, em segundos desde o primeiro
 * quadro renderizado (não desde o início do download).
 */
export function sampleIntro(t: number, zFinal: number = Z_FIM_PADRAO): QuadroAbertura {
  const rasgos = RASGOS.filter((r) => t >= r.t && t < r.t + r.duracao).map(({ y0, y1, dx }) => ({
    y0,
    y1,
    dx,
  }));

  const emRoll = t >= ROLL_INICIO && t < ROLL_FIM;

  return {
    t,
    camera: {
      x: trilha(CAM_X, t),
      y: trilha(CAM_Y, t),
      z: ajustaDolly(trilha(CAM_Z, t), zFinal),
      fov: trilha(CAM_FOV, t),
    },
    ignicao: {
      largura: trilha(IGN_LARGURA, t),
      altura: trilha(IGN_ALTURA, t),
      opacidade: trilha(IGN_OPACIDADE, t),
    },
    chiado: trilha(CHIADO, t),
    ui: trilha(UI, t),
    rasgos,
    scanlines: trilha(SCANLINES, t),
    roll: emRoll ? -0.2 + 1.4 * (((t - ROLL_INICIO) / ROLL_PERIODO) % 1) : null,
    vinheta: trilha(VINHETA, t),
    k1: trilha(BARRIL, t),
  };
}

/**
 * Reescala SÓ o trecho do dolly para terminar em `zFinal`.
 *
 * Tudo antes de `t = 1,15` fica como a §3 escreveu — a aproximação inteira é
 * que estica ou encolhe, não a espera nem o giro. Com `zFinal = 0,26` esta
 * função é a identidade, e é assim que a coreografia da especificação continua
 * sendo o caso padrão em vez de um caso especial.
 */
function ajustaDolly(z: number, zFinal: number): number {
  if (z >= Z_GIRO) return z;
  return Z_GIRO - (Z_GIRO - z) * ((Z_GIRO - zFinal) / (Z_GIRO - Z_FIM_PADRAO));
}

/**
 * O último quadro, para onde o skip salta (§8).
 *
 * Skip **não** acelera o que falta: quem pulou quer o fim agora, não a mesma
 * coisa em 3×. Por isso é o estado final, não uma timeline comprimida.
 */
export function quadroFinal(zFinal?: number): QuadroAbertura {
  return sampleIntro(DURACAO_ABERTURA, zFinal);
}

/**
 * O quadro parado da variante `prefers-reduced-motion` (§9).
 *
 * Câmera na posição final, sem dolly e sem giro. Movimento de câmera entrando
 * em objeto é gatilho vestibular conhecido, e o dolly com ease-in é justamente
 * o tipo mais provocativo — some inteiro. Sobra a identidade visual: ruído
 * congelado, sem roll bar, sem rasgos, sem barril.
 */
export function quadroReduzido(zFinal?: number): QuadroAbertura {
  const fim = quadroFinal(zFinal);
  return {
    ...fim,
    ignicao: { largura: 0, altura: 0, opacidade: 0 },
    chiado: 0.2,
    ui: 1,
    rasgos: [],
    scanlines: 0.2,
    roll: null,
    vinheta: 0.25,
    k1: 0,
  };
}
