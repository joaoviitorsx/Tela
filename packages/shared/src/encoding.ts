/**
 * Presets de encoding.
 *
 * # Simulcast não existe aqui, e o tipo dizia que sim
 *
 * Este cabeçalho anunciava "REGRA INEGOCIÁVEL: duas camadas de simulcast,
 * nunca três", e o tipo carregava `layers: [SimulcastLayer, SimulcastLayer]`
 * mais um `upstreamBps`. Nada disso era lido em lugar nenhum do runtime: só
 * `layers[0].width` e `layers[0].height` chegavam ao encoder, e a `encoding`
 * de dentro da camada duplicava o `main`.
 *
 * A regra era verdadeira na topologia de SFU, onde o transmissor sobe uma vez
 * e o servidor escolhe a camada por espectador. Em malha P2P cada conexão tem
 * UM receptor, e o controle de congestionamento dela já adapta o encoding
 * àquele espectador — simulcast só multiplicaria encoders na máquina que está
 * rodando o jogo. A ADR 0005 trocou a topologia; o tipo ficou descrevendo a
 * antiga.
 *
 * O que sobrou é o que sempre foi usado: uma resolução e um encoding.
 */

export type LayerEncoding = {
  readonly maxBitrate: number;
  readonly maxFramerate: number;
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
 * Referências verificadas (ADR 0019): o YouTube Live recomenda exatamente
 * 12 Mbps para 1080p60 em H.264, e os 5,8 Mbps do OBS são literais no código
 * deles — `EstimateMinBitrate` ancora `1920x1080@60 == 5800` numa fórmula
 * `pow(cx*cy, 0.85) * sqrt(pow(fps, 1.1))`.
 *
 * O terceiro item desta lista dizia que realtime — 1 passe, CBR, sem B-frames,
 * sem lookahead — custa 10 a 20% a mais que o mesmo alvo em VOD. **Não achei
 * medição publicada disso.** É plausível e consistente com a literatura de
 * rate-distortion, mas continua sendo premissa, não fato. O que sustenta a
 * margem sobre o YouTube é outra coisa, e essa tem fonte: o Zoom, que também é
 * tempo real e também é 1 passe, publica 12,8 Mbps para 1080p60.
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
  /** A resolução que o encoder recebe. Era `layers[0]`, quando havia camadas. */
  readonly width: number;
  readonly height: number;
  readonly main: LayerEncoding & { readonly priority: 'high' };
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
  width: 1920,
  height: 1080,
  main: { maxBitrate: 12_000_000, maxFramerate: 60, priority: 'high' },
};

export const PRESET_900P60: EncodingPreset = {
  id: 'p900p60',
  label: '900p60',
  hint: 'Fibra comum. ~8 Mbps por espectador.',
  width: 1600,
  height: 900,
  main: { maxBitrate: 8_000_000, maxFramerate: 60, priority: 'high' },
};

export const PRESET_720P60: EncodingPreset = {
  id: 'p720p60',
  label: '720p60',
  hint: 'Conexão comum. ~5,5 Mbps por espectador.',
  width: 1280,
  height: 720,
  main: { maxBitrate: 5_500_000, maxFramerate: 60, priority: 'high' },
};

export const PRESET_600P60: EncodingPreset = {
  id: 'p600p60',
  label: '576p60',
  hint: 'Upload modesto ou vários assistindo. ~3,6 Mbps.',
  width: 1024,
  height: 576,
  main: { maxBitrate: 3_600_000, maxFramerate: 60, priority: 'high' },
};

export const PRESET_480P60: EncodingPreset = {
  id: 'p480p60',
  label: '480p60',
  hint: 'Upload apertado. ~2,5 Mbps por espectador.',
  width: 854,
  height: 480,
  main: { maxBitrate: 2_500_000, maxFramerate: 60, priority: 'high' },
};

export const PRESET_360P60: EncodingPreset = {
  id: 'p360p60',
  label: '360p60',
  hint: 'Último degrau. ~1,4 Mbps — abaixo disso a alternativa não é pior qualidade, é não transmitir.',
  width: 640,
  height: 360,
  main: { maxBitrate: 1_400_000, maxFramerate: 60, priority: 'high' },
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
 * `contentHint` por prioridade — a metade que faltava do modo `nitidez`.
 *
 * O hint não é cosmético: ele troca o CAMINHO de codificação no Chromium.
 *
 * `motion` liga o rate controller de vídeo comum e, com ele, o *quality
 * scaler* — o mecanismo que derruba RESOLUÇÃO sozinho quando o QP passa do
 * limiar. É o certo para gameplay: movimento é a informação, e a queda de
 * resolução é o preço aceito.
 *
 * `detail` liga o modo de conteúdo de tela: o encoder passa a preservar
 * resolução e a cortar QUADROS. É o que faz texto de mapa e de inventário
 * continuar legível.
 *
 * Antes `nitidez` só trocava `degradationPreference`, e pedia ao encoder para
 * segurar uma resolução que o orçamento não pagava — sem tocar no caminho que
 * de fato decide isso. Metade do controle não fazia nada. ADR 0015.
 */
export const CONTENT_HINT_POR_PRIORIDADE: Record<Prioridade, 'motion' | 'detail'> = {
  fluidez: 'motion',
  nitidez: 'detail',
};

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
  /**
   * Fração do upstream medido que pode ser usada — o resto é folga
   * anti-bufferbloat.
   *
   * Era 0,7 aqui e 0,75 no `UplinkGovernor`: o produto SUGERIA o degrau com um
   * número e OPERAVA com outro. Uma folga só, e é a do governador, porque é
   * ela que de fato chega ao encoder.
   */
  uplinkHeadroom: 0.75,
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
  /*
    O custo real por espectador é o TETO de bits por pixel, não o nominal do
    degrau: a topologia gasta `min(orçamento, BPP_TETO × pixels)`, que pode ser
    bem acima do rótulo. Usar o nominal subestimava o custo e prometia mais
    espectadores do que cabem.
  */
  const { width, height } = preset;
  const perViewer = Math.max(
    preset.main.maxBitrate,
    BPP_TETO * width * height * preset.main.maxFramerate,
  );
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
 * Piso de bits por pixel para conteúdo de movimento alto em H.264 realtime.
 *
 * É o número que a ADR 0010 fixou e que a escada inteira respeita. Abaixo
 * disto o controlador de taxa só tem uma saída — subir o QP — e QP alto é o
 * quadriculado; pior, o *quality scaler* do Chrome começa a derrubar
 * resolução por conta própria, e essa queda COMPÕE com a nossa. O resultado
 * é a imagem borrada que nenhuma das duas malhas pediu.
 */
export const BPP_PISO = 0.10;

/**
 * Teto útil de bits por pixel.
 *
 * Era 0,20, e eu tinha inventado esse número. Um levantamento das referências
 * publicadas — OBS, Twitch, YouTube Live, Discord, Zoom, Meet, libwebrtc,
 * LiveKit, Jitsi, mediasoup, Janus — não achou NENHUMA que passe de 0,103 bpp
 * em 1080p60. A maior de todas é o Zoom, com 12,8 Mbps, e ele é o comparável
 * mais justo que existe: também é tempo real, também é um passe.
 *
 * 0,20 autorizava 1,94× o maior número publicado do mercado, e custava
 * 124 Mbps de subida com cinco espectadores.
 *
 * 0,13 fica 1,29× acima do YouTube Live e 1,21× acima do Zoom — margem que
 * paga folgadamente o prêmio de tempo real e de movimento de gameplay, sem
 * gastar banda que ninguém demonstrou virar imagem. Em 1080p60 são 16,2 Mbps.
 */
export const BPP_TETO = 0.13;

/** Bits por pixel de um alvo. A conta que decide se a imagem se sustenta. */
export function bitsPorPixel(
  bitsPerSecond: number,
  width: number,
  height: number,
  fps: number,
): number {
  const pixelsPorSegundo = width * height * fps;
  if (pixelsPorSegundo <= 0) return 0;
  return bitsPerSecond / pixelsPorSegundo;
}

/**
 * Quanto o framerate custa em bitrate, contra a referência de 60fps.
 *
 * `presetForBitrate` assumia proporcionalidade direta — 30fps custaria metade
 * de 60fps, então o mesmo orçamento pagaria o dobro de bits por pixel e caberia
 * um degrau bem maior. Nenhuma tabela publicada concorda:
 *
 *     OBS (fórmula literal)   fps^0.55   →  1,46× para dobrar o fps
 *     YouTube Live 1080p                    1,20×
 *     YouTube Live 720p                     1,50×
 *     Twitch 1080p / 720p                   1,33× / 1,50×
 *
 * A mediana do mercado é ~1,5×, não 2,0×. O modo `nitidez` estava se creditando
 * 33% de banda que não existe, e escolhendo um degrau alto demais para o
 * orçamento — o oposto do que ele promete.
 *
 * `fps^0.55` é a do OBS, que é a única publicada como fórmula em vez de tabela.
 */
export function custoDeFramerate(fps: number): number {
  const alvo = Number.isFinite(fps) && fps > 0 ? fps : 60;
  return Math.pow(alvo / 60, 0.55);
}

/**
 * Framerate alvo por prioridade.
 *
 * `fluidez` mantém 60fps — em gameplay o movimento É a informação.
 *
 * `nitidez` corta para 30fps, e o corte é o ponto: metade dos quadros libera
 * o DOBRO de bits para cada um. Pelo MESMO orçamento sai 1280×720@30 em vez
 * de 854×480@60. Quem está mostrando um mapa, um inventário ou texto quer o
 * primeiro; quem está jogando quer o segundo.
 *
 * Antes `nitidez` só trocava `degradationPreference` e não mexia em pixel
 * nenhum — pedia ao encoder para segurar uma resolução que o orçamento não
 * pagava, que é a definição do problema, não a solução dele.
 */
export const FRAMERATE_POR_PRIORIDADE: Record<Prioridade, number> = {
  fluidez: 60,
  nitidez: 30,
};

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
export function presetForBitrate(
  perViewerBitsPerSecond: number,
  fps: number = 60,
): PresetId {
  if (!Number.isFinite(perViewerBitsPerSecond) || perViewerBitsPerSecond <= 0) {
    return PISO_DA_ESCADA;
  }
  /**
   * A escada é tabelada a 60fps. A 30fps o mesmo orçamento paga o DOBRO de
   * bits por pixel, então cabe uma resolução maior — e é assim que `nitidez`
   * entrega 720p30 onde `fluidez` entrega 480p60, sem pedir um bit a mais.
   */
  const alvo = Number.isFinite(fps) && fps > 0 ? fps : 60;

  /**
   * O critério é BITS POR PIXEL, não o rótulo de bitrate do degrau.
   *
   * Era `equivalente >= PRESETS[id].main.maxBitrate`, e três degraus da tabela
   * têm nominal ABAIXO do piso: 1080p60 a 0,0965, 900p60 a 0,0926, 720p60 a
   * 0,0995. O resultado era uma escada não-monótona, em que mais banda
   * produzia imagem PIOR:
   *
   *     7,75 Mbps → p720p60 → 0,140 bpp
   *     8,00 Mbps → p900p60 → 0,093 bpp   ← 3% mais banda, 34% menos densidade
   *    11,75 Mbps → p900p60 → 0,136 bpp
   *    12,00 Mbps → p1080p60 → 0,097 bpp
   *
   * As faixas venenosas eram 8,00–8,64 e 12,00–12,44 Mbps por espectador — um
   * link de 23 Mbps com dois espectadores cai exatamente na primeira. E abaixo
   * de 0,10 o quality scaler do Chromium começa a derrubar resolução por conta
   * própria, compondo com a nossa: o mecanismo da ADR 0015, reintroduzido pela
   * fronteira.
   *
   * `BPP_PISO` existia como constante e nunca era executado em lugar nenhum do
   * runtime — só em comentário, e num teste que foi afrouxado para `>= 0,09`
   * em vez de consertar o código. Agora é regra.
   */
  /*
    O piso de bits por pixel é a 60fps. A 30fps o mesmo quadro custa
    `(30/60)^0.55 = 0,68` do que custaria a 60 — não metade, como a versão
    anterior assumia. Ver `custoDeFramerate`.
  */
  const exigido = BPP_PISO * 60 * custoDeFramerate(alvo);
  for (const id of PRESET_ORDER) {
    const { width, height } = PRESETS[id];
    if (perViewerBitsPerSecond >= exigido * width * height) return id;
  }
  return PISO_DA_ESCADA;
}

