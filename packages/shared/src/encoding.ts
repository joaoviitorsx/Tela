/**
 * Presets de encoding.
 *
 * REGRA INEGOCIÁVEL (AGENTS.md R5): duas camadas de simulcast, nunca três.
 * Cada camada é um encoder rodando na mesma máquina que o jogo. Três encoders
 * 1080p60 derrubam o FPS do jogo. Duas cobrem os dois cenários reais que
 * importam — fibra e móvel — com metade do custo de CPU.
 */

export type LayerEncoding = {
  readonly maxBitrate: number;
  readonly maxFramerate: number;
};

export type SimulcastLayer = {
  readonly width: number;
  readonly height: number;
  readonly encoding: LayerEncoding;
};

/**
 * Escada calibrada por BITS POR PIXEL, não por rótulo bonito.
 *
 * A tabela anterior vendia resolução e entregava fome: `p1080p60` a 8 Mbps são
 * 0,064 bpp, e conteúdo de movimento alto — um flick de CS, onde a tela
 * inteira muda de quadro para quadro e vetor de movimento não ajuda — precisa
 * de 0,10 a 0,20. O encoder só tinha uma saída, subir o QP, e QP alto É o
 * quadriculado. Acontecia com UM espectador num link de fibra, sem teto de
 * upload nenhum: não era a rede, era a tabela.
 *
 * Referências: YouTube recomenda 12 Mbps para 1080p60 em H.264; o OBS usa
 * 5,8 Mbps como MÍNIMO para 1080p60; e realtime (1 passe, CBR, sem B-frames,
 * sem lookahead) custa 10–20% a mais que o mesmo alvo em VOD.
 *
 * Todos os degraus agora são 60fps, e cada um tira PIXEL de verdade. Some o
 * `p720p30`, que tinha a mesma resolução do degrau acima e só cortava
 * framerate — no orçamento dele cabe 360p60, que preserva o movimento, que é
 * a informação em gameplay.
 */
export type PresetId =
  | 'p1080p60'
  | 'p900p60'
  | 'p720p60'
  | 'p600p60'
  | 'p480p60'
  | 'p360p60';

export type EncodingPreset = {
  readonly id: PresetId;
  readonly label: string;
  /** Texto curto que a UI mostra abaixo do rótulo. Fala de rede, não de pixel. */
  readonly hint: string;
  /** Upstream total aproximado com as duas camadas, em bits/s. Base do orçamento P2P. */
  readonly upstreamBps: number;
  readonly main: LayerEncoding & { readonly priority: 'high' };
  readonly layers: readonly [SimulcastLayer, SimulcastLayer];
};

/**
 * Cada degrau abaixo mantém ~0,10 bit por pixel — o piso para conteúdo de
 * movimento alto sem virar bloco. É o número que a tabela antiga não tinha:
 * ela variava de 0,045 a 0,072 conforme o degrau, sem critério.
 */
export const PRESET_1080P60: EncodingPreset = {
  id: 'p1080p60',
  label: '1080p60',
  hint: 'Fibra boa. ~12 Mbps de subida por espectador.',
  upstreamBps: 16_000_000,
  main: { maxBitrate: 12_000_000, maxFramerate: 60, priority: 'high' },
  layers: [
    { width: 1920, height: 1080, encoding: { maxBitrate: 12_000_000, maxFramerate: 60 } },
    { width: 1280, height: 720, encoding: { maxBitrate: 4_000_000, maxFramerate: 30 } },
  ],
};

export const PRESET_900P60: EncodingPreset = {
  id: 'p900p60',
  label: '900p60',
  hint: 'Fibra comum. ~8 Mbps por espectador.',
  upstreamBps: 10_600_000,
  main: { maxBitrate: 8_000_000, maxFramerate: 60, priority: 'high' },
  layers: [
    { width: 1600, height: 900, encoding: { maxBitrate: 8_000_000, maxFramerate: 60 } },
    { width: 1024, height: 576, encoding: { maxBitrate: 2_600_000, maxFramerate: 30 } },
  ],
};

export const PRESET_720P60: EncodingPreset = {
  id: 'p720p60',
  label: '720p60',
  hint: 'Conexão comum. ~5,5 Mbps por espectador.',
  upstreamBps: 7_300_000,
  main: { maxBitrate: 5_500_000, maxFramerate: 60, priority: 'high' },
  layers: [
    { width: 1280, height: 720, encoding: { maxBitrate: 5_500_000, maxFramerate: 60 } },
    { width: 854, height: 480, encoding: { maxBitrate: 1_800_000, maxFramerate: 30 } },
  ],
};

export const PRESET_600P60: EncodingPreset = {
  id: 'p600p60',
  label: '576p60',
  hint: 'Upload modesto ou vários assistindo. ~3,6 Mbps.',
  upstreamBps: 4_800_000,
  main: { maxBitrate: 3_600_000, maxFramerate: 60, priority: 'high' },
  layers: [
    { width: 1024, height: 576, encoding: { maxBitrate: 3_600_000, maxFramerate: 60 } },
    { width: 640, height: 360, encoding: { maxBitrate: 1_200_000, maxFramerate: 30 } },
  ],
};

export const PRESET_480P60: EncodingPreset = {
  id: 'p480p60',
  label: '480p60',
  hint: 'Upload apertado. ~2,5 Mbps por espectador.',
  upstreamBps: 3_400_000,
  main: { maxBitrate: 2_500_000, maxFramerate: 60, priority: 'high' },
  layers: [
    { width: 854, height: 480, encoding: { maxBitrate: 2_500_000, maxFramerate: 60 } },
    { width: 640, height: 360, encoding: { maxBitrate: 900_000, maxFramerate: 30 } },
  ],
};

export const PRESET_360P60: EncodingPreset = {
  id: 'p360p60',
  label: '360p60',
  hint: 'Último degrau. ~1,4 Mbps — abaixo disso a alternativa não é pior qualidade, é não transmitir.',
  upstreamBps: 1_900_000,
  main: { maxBitrate: 1_400_000, maxFramerate: 60, priority: 'high' },
  layers: [
    { width: 640, height: 360, encoding: { maxBitrate: 1_400_000, maxFramerate: 60 } },
    { width: 426, height: 240, encoding: { maxBitrate: 500_000, maxFramerate: 30 } },
  ],
};

export const PRESETS = {
  p1080p60: PRESET_1080P60,
  p900p60: PRESET_900P60,
  p720p60: PRESET_720P60,
  p600p60: PRESET_600P60,
  p480p60: PRESET_480P60,
  p360p60: PRESET_360P60,
} as const;

/**
 * Ordem de exibição e de degradação: melhor primeiro. A UI e a queda automática
 * por CPU iteram nisto, não em `Object.keys` — ordem de chave de objeto é
 * detalhe de runtime, não contrato.
 */
export const PRESET_ORDER: readonly PresetId[] = [
  'p1080p60',
  'p900p60',
  'p720p60',
  'p600p60',
  'p480p60',
  'p360p60',
];

/**
 * Presets que preservam 60fps — agora TODOS eles.
 *
 * A lista existia para excluir `p720p30`, que tinha a mesma resolução do
 * degrau acima: descer nele por pressão de CPU cortava o framerate pela metade
 * sem tirar um pixel do encoder, o oposto de `maintain-framerate` e da R5. Com
 * a escada recalibrada, cada degrau reduz resolução de verdade, então a
 * distinção entre "degrau de CPU" e "degrau de upload" deixou de existir.
 *
 * A lista continua porque a escada de degradação itera nela, e porque um
 * degrau futuro de 30fps traria o mesmo problema de volta.
 */
export const SIXTY_FPS_PRESETS: readonly PresetId[] = [...PRESET_ORDER];

/** Codec único. VP9/AV1 comprimem melhor mas não têm HW encode universal. */
export const VIDEO_CODEC = 'h264' as const;

/** Perder resolução, nunca framerate. O padrão do produto. */
export const DEGRADATION_PREFERENCE = 'maintain-framerate' as const;

/**
 * O que ceder quando os bits não dão para tudo.
 *
 * `fluidez` (padrão) segura os 60fps e deixa a imagem borrar — é o certo para
 * gameplay, onde movimento é a informação.
 *
 * `nitidez` segura a resolução e deixa o framerate cair. Existe porque cena
 * carregada a 1080p60 borra de verdade, e para quem está mostrando algo onde
 * o DETALHE é a informação — um mapa, um inventário, texto — a imagem nítida
 * a 30fps é melhor que a fluida e ilegível.
 *
 * A R5 trava `maintain-framerate` como padrão, e ele continua sendo o padrão.
 * Esta é uma escolha explícita do usuário, registrada na ADR 0009.
 */
export type Prioridade = 'fluidez' | 'nitidez';

// O tipo é declarado à mão: `@tela/shared` compila sem a lib DOM, e puxá-la
// inteira só por um literal traria `window` e `document` para um pacote que
// também roda no servidor.
export const DEGRADATION_BY_PRIORITY: Record<
  Prioridade,
  'maintain-framerate' | 'maintain-resolution'
> = {
  fluidez: 'maintain-framerate',
  nitidez: 'maintain-resolution',
};

/** Sem isso o Chrome trata a captura como 'detail' e gameplay vira slideshow. */
export const CONTENT_HINT = 'motion' as const;

/**
 * Orçamento de upstream no modo P2P (self-host caseiro).
 *
 * No modo SFU o transmissor sobe UMA vez (main + camada baixa) e o servidor
 * replica. No modo P2P o transmissor sobe N vezes — uma por espectador — e
 * roda N encoders. O gargalo deixa de ser o servidor e passa a ser a máquina
 * e o link de casa, exatamente os recursos que o jogo precisa.
 *
 * Ver docs/adr/0002-transporte-p2p-self-host.md.
 */
export const P2P_LIMITS = {
  /**
   * Teto duro de espectadores por transmissão.
   *
   * O custo que escala aqui é BANDA, não CPU: pela R5 todos os peers recebem
   * parâmetros idênticos, então o Chrome reaproveita um encoder só. O que
   * multiplica é o upload — cada espectador recebe uma cópia inteira do vídeo.
   *
   * A 5 espectadores: 12,5 Mbps de subida em `p720p60eco`, 20 em `p720p60`,
   * 40 em `p1080p60`. Quem não tiver o link cai de degrau automaticamente, em
   * conjunto — nunca individualmente, senão viram N encoders (R5).
   */
  maxViewersBrowser: 5,
  /** Fração do upstream medido que pode ser usada — o resto é folga anti-bufferbloat. */
  uplinkHeadroom: 0.7,
} as const;

/**
 * Quantos espectadores o upstream aguenta em P2P, dado o preset.
 * `uplinkBitsPerSecond` é a capacidade de SUBIDA medida ou informada.
 */
export function p2pViewerBudget(
  uplinkBitsPerSecond: number,
  preset: EncodingPreset,
): number {
  // Medição de banda falha. Quando falha, entrega NaN ou Infinity — e um NaN
  // que atravessa `Math.min` sai NaN do outro lado, vira `maxViewers: NaN` na
  // UI e transforma um erro de medição num teto de espectadores sem sentido.
  if (!Number.isFinite(uplinkBitsPerSecond) || uplinkBitsPerSecond <= 0) return 0;
  const usable = uplinkBitsPerSecond * P2P_LIMITS.uplinkHeadroom;
  const perViewer = preset.main.maxBitrate;
  const byBandwidth = Math.floor(usable / perViewer);
  return Math.max(0, Math.min(byBandwidth, P2P_LIMITS.maxViewersBrowser));
}

/**
 * Melhor preset que cabe num upstream, para sugerir em vez de deixar o usuário
 * adivinhar.
 */
export function suggestPreset(uplinkBitsPerSecond: number, viewers: number): PresetId {
  // Sem medição confiável, sugere o degrau mais conservador em vez de chutar
  // alto: errar para baixo custa nitidez, errar para cima custa a transmissão.
  if (!Number.isFinite(uplinkBitsPerSecond) || uplinkBitsPerSecond <= 0) return PISO_DA_ESCADA;
  const budget = uplinkBitsPerSecond * P2P_LIMITS.uplinkHeadroom;
  return presetForBitrate(budget / Math.max(1, viewers));
}

/** O degrau mais baixo. Derivado da ordem, não escrito à mão. */
const PISO_DA_ESCADA: PresetId = PRESET_ORDER[PRESET_ORDER.length - 1] ?? 'p360p60';

/**
 * Maior preset que CABE num orçamento já calculado POR ESPECTADOR.
 *
 * # Por que isto existe
 *
 * O teto de upload corta bitrate; sozinho, ele deixava resolução e framerate
 * no preset. 1920×1080 a 60fps com 3 Mbps são 0,024 bit por pixel, quando
 * movimento alto pede 0,10 a 0,20 — o controlador de taxa só tinha uma saída,
 * subir o QP, e QP alto É o quadriculado. O mesmo orçamento num degrau menor
 * dá o dobro ou o quádruplo de bits por pixel, e imagem mais NÍTIDA: menos
 * pixels, cada um bem codificado.
 *
 * Percorre `PRESET_ORDER` em vez de listar degraus à mão. A versão anterior
 * tinha três `if` encadeados e ficou desatualizada no primeiro degrau novo.
 */
export function presetForBitrate(perViewerBitsPerSecond: number): PresetId {
  if (!Number.isFinite(perViewerBitsPerSecond) || perViewerBitsPerSecond <= 0) {
    return PISO_DA_ESCADA;
  }
  for (const id of PRESET_ORDER) {
    if (perViewerBitsPerSecond >= PRESETS[id].main.maxBitrate) return id;
  }
  return PISO_DA_ESCADA;
}

