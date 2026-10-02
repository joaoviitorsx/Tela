import {
  FRAMERATE_POR_PRIORIDADE,
  pisoDeBitrate,
  tetoDeBitrate,
  type Prioridade,
} from '@tela/shared';
import type { MediaStats } from '../ports/media-transport.js';
import {
  type PresetId,
  menorPreset,
  presetById,
  presetParaOrcamento,
  previousPresetOnRecovery,
} from './presets.js';
import { UplinkGovernor } from './uplink-governor.js';

/**
 * A malha de banda do transmissor: quanto o link paga, e que degrau isso vira.
 *
 * Saiu de `BroadcastSession` na TELA-026, sem mudar comportamento. Lá ela
 * dividia 1.900 linhas com captura, áudio, convite e pausa, e quatro ADRs
 * (0015, 0017, 0018, 0023) tinham de ser lidas contra um arquivo onde metade
 * do estado não era dela. Aqui fica o que é dela: o governador, a evidência de
 * colapso e a sonda de subida.
 *
 * Pura: não fala com transporte nem com relógio. Recebe a leitura do segundo e
 * devolve o que fazer — ou `null`, que é a resposta da maioria das leituras. A
 * sessão aplica: grava o orçamento no transporte e compõe o degrau com as
 * outras duas pressões (usuário e CPU). Ninguém aqui decide o degrau final.
 */

/** Quantas leituras seguidas de `bandwidth` provam colapso, e não soluço. */
const AMOSTRAS_DE_COLAPSO = 3;
/** Mesmo piso do governador: abaixo disso não há vídeo que preste. */
const ORCAMENTO_VIDEO_MINIMO = 300_000;
/** Espera entre sondas de subida, em amostras (1 s). Dobra a cada falha. */
const SONDA_ESPERA_INICIAL = 15;
const SONDA_ESPERA_MAX = 240;
/** Quanto tempo uma sonda precisa aguentar sem colapso para valer. */
const SONDA_JANELA = 10;
/**
 * Estimativa acima de `1,3×` o que sai: perto do teto `1,5×acked` do
 * libwebrtc, ou seja, é a nossa atuação que limita, não a rede.
 */
const SONDA_FOLGA = 1.3;

/** O que a malha precisa saber a cada segundo. Tudo vem da sessão. */
export type LeituraDaMalha = {
  readonly stats: Pick<MediaStats, 'limitation' | 'bitrateBps' | 'paresMedidos' | 'availablePorPeer' | 'frescosPorPeer'>;
  /** O degrau que está no ar agora — dele sai o teto de pixel. */
  readonly presetEfetivo: PresetId;
  /** O que o usuário pediu: teto da sonda. */
  readonly presetEscolhido: PresetId;
  /** Onde a própria malha deixou o degrau da banda (`null`: não restringe). */
  readonly presetPorBanda: PresetId | null;
  readonly prioridade: Prioridade;
  /** Bits por segundo que o áudio ocupa em cada caminho (TELA-017). */
  readonly reservaAudio: number;
  /** Número da amostra na transmissão: o relógio da sonda. */
  readonly amostra: number;
};

/** Orçamento novo para o vídeo, e o degrau que ele paga com bpp honesto. */
export type DecisaoDaMalha = {
  readonly orcamentoVideo: number;
  readonly presetPorBanda: PresetId;
};

/** O que sobra para o vídeo depois da reserva do áudio, nunca abaixo do piso. */
export function orcamentoDeVideo(total: number, reservaAudio: number): number {
  return Math.max(ORCAMENTO_VIDEO_MINIMO, total - reservaAudio);
}

/**
 * O encoder está mandando bem menos do que o orçamento: cena parada. A leitura
 * baixa fala do conteúdo, não do link — nem o orçamento nem a porta (ADR 0030)
 * descem com ela.
 */
export function encoderOcioso(enviadoPorCaminho: number, orcamento: number | null): boolean {
  return orcamento !== null && enviadoPorCaminho > 0 && enviadoPorCaminho < orcamento * 0.7;
}

export class MalhaDeBanda {
  private readonly governor = new UplinkGovernor();
  /** Amostras seguidas com a banda amarrando o encoder. Ver `observar`. */
  private amostrasDeBanda = 0;
  /** Amostra da última mudança de orçamento, pela malha ou pela sonda. */
  private ultimaDecisaoEm = 0;
  /** Sonda de subida. Ver `talvezSondar`. */
  private sondaEspera = SONDA_ESPERA_INICIAL;
  private sondaDesde: number | null = null;
  /** O orçamento de antes da sonda: para onde ela volta se falhar. */
  private orcamentoAntesDaSonda: number | null = null;
  private amostra = 0;

  /** O orçamento em vigor, POR caminho (vídeo + áudio). `null` sem medição. */
  get orcamento(): number | null {
    return this.governor.orcamento;
  }

  /** A estimativa suavizada do pior caminho. `null` sem medição. */
  get estimativa(): number | null {
    return this.governor.estimativa;
  }

  /** Começa sabendo o que o link deu da última vez. */
  semear(bps: number): void {
    this.governor.seed(bps);
  }

  reiniciar(): void {
    this.governor.reset();
    this.amostrasDeBanda = 0;
    this.ultimaDecisaoEm = 0;
    this.sondaEspera = SONDA_ESPERA_INICIAL;
    this.sondaDesde = null;
    this.orcamentoAntesDaSonda = null;
    this.amostra = 0;
  }

  /**
   * Impede o encoder de encher o cano do usuário.
   *
   * O WebRTC estima quanto cabe no link e sobe até lá. "Até lá" é exatamente
   * onde a fila do roteador enche e o ping do jogo dispara — e quando o
   * controle de congestionamento percebe, o jogador já sentiu. Então o teto é
   * aplicado ANTES: o vídeo nunca pede mais do que uma fração do estimado.
   */
  observar(l: LeituraDaMalha): DecisaoDaMalha | null {
    const stats = l.stats;
    this.amostra = l.amostra;
    /**
     * A estimativa chega SOMADA entre os peers; o teto sai POR sender.
     *
     * `stats-sampler` soma `availableOutgoingBitrate` de todas as conexões,
     * porque para o HUD o que interessa é o total que sai do link de casa. Mas
     * `setBitrateCeiling` grava o número como `maxBitrate` de CADA sender — e
     * em mesh cada espectador recebe uma cópia inteira do vídeo.
     *
     * Sem esta divisão o erro era proporcional ao número de espectadores e
     * sempre na direção de ENCHER o cano, que é precisamente o que esta malha
     * existe para impedir: com 3 espectadores num link de 12 Mbps o teto
     * liberava 8 Mbps por sender, ou seja, 24 Mbps de demanda num cano de 12.
     *
     * É a mesma conta que `suggestPreset` e `p2pViewerBudget` já faziam em
     * `@tela/shared` — a malha de controle é que estava fora de compasso.
     */
    /**
     * O MÍNIMO, não a média — e o divisor conta quem de fato mediu.
     *
     * Pela R5 todos os senders recebem o mesmo `maxBitrate`, então o que cabe é
     * o que o PIOR caminho aguenta. Somar e dividir por N deixava um amigo em
     * ADSL de 5 Mbps recebendo 24 Mbps porque o outro estava em fibra: ~80% de
     * perda contínua para ele, quadriculado permanente, e o transmissor sem
     * ver nada, porque o HUD mostra a soma. A ADR 0017 declarava a intenção
     * certa e o código fazia o oposto.
     *
     * E o divisor era `peers.length`, que conta quem ainda está em
     * `connecting` — quem conecta não tem par ICE nominado e não contribui
     * para a soma. Numerador e denominador fora de fase: cinco amigos entrando
     * de uma vez subestimavam o orçamento em até 5× no pior instante, e pela
     * catraca da ADR 0018 a transmissão morava lá o resto da sessão.
     */
    /**
     * A queda só vale quando a leitura fala do LINK.
     *
     * Duas condições em que ela não fala, e o simulador mediu as duas:
     *
     * - o teto do sender está sendo definido pelo limite de bits por pixel do
     *   degrau, e não pelo orçamento — então `acked` reflete a nossa escolha
     *   de resolução, não a capacidade da rede;
     * - o encoder não está consumindo o que lhe foi dado, porque a cena está
     *   parada — `acked` desaba sem a rede ter mudado, e o teto de
     *   `1,5 × acked` desce atrás.
     *
     * Nos dois casos, deixar o governador cortar transforma uma condição
     * transitória em perda permanente de orçamento.
     */
    const preset = presetById(l.presetEfetivo);
    const tetoDePixel = tetoDeBitrate(
      preset.width,
      preset.height,
      Math.min(preset.main.maxFramerate, FRAMERATE_POR_PRIORIDADE[l.prioridade]),
    );
    const orcamento = this.governor.orcamento;

    /**
     * Colapso de link: o sinal que faltava às duas guardas (TELA-015).
     *
     * As guardas abaixo existem por bons motivos e nenhuma distingue a própria
     * causa de um colapso de rede. Num colapso o WebRTC entrega
     * `min(BWE, maxBitrate)` ao encoder, então o envio cai junto — como na
     * cena parada — e a estimativa cai junto com o envio — como quando somos
     * nós o limitador. Medido, com o `BroadcastSession` real: link por
     * espectador de 27 para 2,7 Mbps sustentado deixava o orçamento congelado
     * em 20,25 Mbps, o degrau em 1080p60 e a tela calada, a 0,0217 bpp. No
     * simulador, a sub-matriz de queda (link a 15% por 30 s) não reagia em
     * NENHUM dos 24 cenários.
     *
     * O que separa os três casos é `qualityLimitationReason`. Ele diz
     * `bandwidth` quando é a ESTIMATIVA DE BANDA que está amarrando o encoder.
     * Na cena parada o encoder não quer mais bits, e o motivo fica `none`;
     * quando o limitador é o nosso teto de pixel (`scaleResolutionDownBy`),
     * também. Só o colapso produz `bandwidth` sustentado com orçamento acima
     * do que o link entrega.
     *
     * Três amostras seguidas, e não uma: `bandwidth` isolado aparece em toda
     * rajada de perda, e a histerese é o que impede um soluço de Wi-Fi de
     * derrubar a qualidade. As tentativas anteriores (guardas que expiram,
     * desempate pela leitura crua ou suavizada) mexiam nas guardas; esta não
     * mexe — acrescenta a evidência que elas não tinham.
     */
    this.amostrasDeBanda = stats.limitation === 'bandwidth' ? this.amostrasDeBanda + 1 : 0;
    const colapso = this.amostrasDeBanda >= AMOSTRAS_DE_COLAPSO;

    const limitadosPorPixel = orcamento !== null && tetoDePixel < orcamento;
    const enviado = stats.bitrateBps / Math.max(1, stats.paresMedidos);
    const ocioso = encoderOcioso(enviado, orcamento);

    // O pior caminho medido nesta amostra, para comparar com o orçamento em
    // vigor: é ele que distingue cena parada de link que encolheu. O envio
    // por caminho é a régua do aquecimento por caminho (ADR 0030).
    const decisao = this.governor.observe(stats.availablePorPeer, {
      permitirQueda: colapso || (!limitadosPorPixel && !ocioso),
      enviadoPorCaminho: enviado,
      ...(stats.frescosPorPeer === undefined ? {} : { frescos: stats.frescosPorPeer }),
    });
    // `null` na maioria das leituras: o governador só fala quando a mudança
    // compensa reconfigurar o encoder.
    if (decisao === null) return this.talvezSondar(l, enviado);
    // Queda dentro da janela de uma sonda: ela falhou, e a próxima espera dobra.
    let bps = decisao.bps;
    if (this.sondaDesde !== null && decisao.bps < (orcamento ?? Infinity)) {
      this.sondaEspera = Math.min(this.sondaEspera * 2, SONDA_ESPERA_MAX);
      this.sondaDesde = null;
      /**
       * A sonda que falha VOLTA para onde estava, não para onde a queda a
       * levou. O sobreuso que ela mesma causou recua o estimador a 0,85 da
       * fatia, e `0,75 ×` disso fica abaixo do orçamento que ESTAVA
       * funcionando: medido na sala de 50 num link de 300 Mbps, sondar 720p
       * a partir de 600p terminava em 480p — e lá ficava, porque a espera
       * já tinha dobrado até 240 s. É a nossa atuação sendo medida de novo
       * (ADR 0018). Se o link caiu de verdade no mesmo instante, as leituras
       * seguintes cortam a partir do valor restaurado, como sempre.
       */
      const volta = this.orcamentoAntesDaSonda;
      if (volta !== null && decisao.bps < volta) {
        this.governor.sondar(volta);
        bps = volta;
      }
    }
    this.orcamentoAntesDaSonda = null;
    this.ultimaDecisaoEm = this.amostra;
    const paraVideo = orcamentoDeVideo(bps, l.reservaAudio);

    /**
     * E AQUI está a correção que a ADR 0015 existe para registrar.
     *
     * O teto sempre foi aplicado como `maxBitrate`, e `maxBitrate` sozinho não
     * tira um único pixel do encoder — só aperta o QP. Com um orçamento de
     * 3 Mbps e o degrau parado em 1080p60, o encoder recebia 1920×1080@60 para
     * caber em 0,024 bit por pixel, quando movimento alto pede 0,10. A saída
     * dele era subir o QP até o talo e, logo depois, deixar o *quality scaler*
     * do Chromium derrubar a resolução por conta própria — uma queda que
     * COMPÕE com a nossa e que ninguém mede.
     *
     * A imagem resultante não era quadriculada, era BORRADA: 360p esticado
     * para a tela do espectador, com o produto anunciando 1080p60.
     *
     * Traduzir o orçamento em degrau é o que mantém os bits por pixel
     * honestos. Os mesmos 3 Mbps em 854×480@60 são 0,10 bpp — nítido de
     * verdade, num rótulo menor.
     */
    return { orcamentoVideo: paraVideo, presetPorBanda: presetParaOrcamento(paraVideo, l.prioridade) };
  }

  /**
   * Sonda de subida depois de uma descida por banda (TELA-015, ADR 0023).
   *
   * O problema que ela resolve é estrutural, e a ADR 0018 o descreve do outro
   * lado: no degrau baixo o `maxBitrate` fica no teto de pixel DAQUELE degrau,
   * o `acked` não passa dele, o libwebrtc tampa a estimativa em `1,5×acked`,
   * e o orçamento que sai disso (`0,75 ×`) não alcança o limiar do degrau de
   * cima. Descer por um colapso virava estado absorvente: o link voltava e a
   * transmissão ficava em 360p para sempre.
   *
   * A sonda sobe UM degrau quando duas coisas são verdade ao mesmo tempo:
   * `sondaEspera` amostras sem decisão nenhuma, e estimativa colada no teto
   * `1,5×acked` — sinal de que o limitador somos nós, não a rede (num
   * colapso de verdade a estimativa fica rente ao `acked`). Se a malha
   * descer dentro da janela, a sonda falhou e a próxima espera DOBRA
   * (15 → 240 s). Não é um relógio
   * cego: sem evidência de folga ela não dispara, e cada falha a afasta.
   *
   * A ADR 0023 só sondava depois de uma descida por COLAPSO, para não trocar
   * estabilidade por reconfiguração num link legitimamente pequeno. A sala
   * grande mostrou que a restrição deixava a malha presa depois de QUALQUER
   * descida (ADR 0030): subir sem sonda exige `alvo/aplicado ≥ 1,06` com a
   * razão `1,125 × (1 − viés do mínimo de N)`, e o viés do mínimo de 20 ou 50
   * caminhos suavizados come os 12,5 % inteiros — nenhum degrau sobe sozinho.
   * O que separa "somos nós" de "é o link" nunca foi a origem da descida; é a
   * folga da estimativa sobre o envio, que já é a condição da sonda. Num link
   * pequeno de verdade ela não dispara; onde dispara e falha, a espera dobra.
   */
  private talvezSondar(l: LeituraDaMalha, enviadoPorPeer: number): DecisaoDaMalha | null {
    const estimativa = this.governor.estimativa;
    const porBanda = l.presetPorBanda;
    if (estimativa === null || porBanda === null || this.governor.orcamento === null) return null;
    // De volta ao que a pessoa escolheu: não há o que sondar.
    if (menorPreset(porBanda, l.presetEscolhido) === l.presetEscolhido) return null;

    if (this.sondaDesde !== null) {
      // Sobreviveu à janela: a subida valeu, e a espera volta ao começo.
      if (this.amostra - this.sondaDesde >= SONDA_JANELA) {
        this.sondaEspera = SONDA_ESPERA_INICIAL;
        this.sondaDesde = null;
      }
      return null;
    }
    /*
      Espera contada desde a última decisão, e NÃO desde a última leitura de
      `bandwidth`: medido em Chrome real, o `qualityLimitationReason` fica em
      `bandwidth` continuamente com link farto quando o conteúdo é pesado (é o
      quality scaler, que o libwebrtc atribui a banda). Esperar "sem banda"
      travaria a sonda justamente em gameplay.
    */
    if (this.amostra - this.ultimaDecisaoEm < this.sondaEspera) return null;
    if (enviadoPorPeer <= 0 || estimativa < enviadoPorPeer * SONDA_FOLGA) return null;

    const acima = previousPresetOnRecovery(porBanda, l.presetEscolhido);
    if (acima === null) return null;
    const alvo = presetById(acima);
    const fps = Math.min(alvo.main.maxFramerate, FRAMERATE_POR_PRIORIDADE[l.prioridade]);
    // O piso do degrau de cima é o menor orçamento que a escada traduz nele.
    let bps = Math.ceil(pisoDeBitrate(alvo.width, alvo.height, fps) * 1.02);
    if (menorPreset(presetParaOrcamento(bps, l.prioridade), acima) !== acima) {
      bps = Math.ceil(alvo.main.maxBitrate);
    }

    // O governador conta o caminho inteiro; o degrau é só do vídeo.
    this.orcamentoAntesDaSonda = this.governor.orcamento;
    this.governor.sondar(bps + l.reservaAudio);
    this.sondaDesde = this.amostra;
    this.ultimaDecisaoEm = this.amostra;
    return { orcamentoVideo: bps, presetPorBanda: presetParaOrcamento(bps, l.prioridade) };
  }
}
