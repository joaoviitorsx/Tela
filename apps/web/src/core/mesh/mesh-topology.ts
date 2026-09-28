import {
  DEGRADATION_BY_PRIORITY,
  type EncodingPreset,
  FRAMERATE_POR_PRIORIDADE,
  type IceServerConfig,
  type Prioridade,
  bitsPorPixel,
  tetoDeBitrate,
} from '@tela/shared';
import { Emitter } from '../emitter.js';
import { PeerLink, PeerLinkError, type PeerLinkFatalCode, type PeerLinkIssueCode } from './peer-link.js';

/**
 * A malha vista do transmissor: uma `PeerLink` por espectador.
 *
 * # A regra que protege o FPS do jogo
 *
 * **Todos os peers recebem parâmetros de encoding IDÊNTICOS.**
 *
 * O Chrome reaproveita o mesmo encoder entre `RTCRtpSender`s cujos parâmetros
 * batem: um encode, três envios. Varie o bitrate por peer e viram três
 * encoders 1080p60 disputando a GPU com o jogo — que é exatamente o recurso
 * que este produto existe para proteger.
 *
 * Portanto a adaptação é **coletiva**: se um espectador tem rede ruim, ou ele
 * aguenta o que está sendo enviado, ou todos descem juntos um degrau. É a
 * quarta regra de mídia do AGENTS.md R5, e a que mais parece errada à
 * primeira vista — alguém vai tentar "otimizar" isto depois. Não deixe.
 */
/**
 * Um relatório de estatística COM a identidade do peer.
 *
 * Era um array solto de `RTCStatsReport`, e o índice posicional virava chave —
 * tanto para o delta de bytes quanto para a média por caminho. Índice não é
 * identidade: quando um peer sai, todos os seguintes deslizam e as leituras
 * são atribuídas ao peer errado por uma amostra.
 */
export type RelatorioDePeer = {
  readonly peerId: string;
  readonly report: RTCStatsReport;
};

export type PeerInfo = {
  readonly id: string;
  readonly connectionState: RTCPeerConnectionState;
  /** `true` quando o caminho passa por TURN: latência maior, cota consumida. */
  readonly usingRelay: boolean;
};

export type TopologyEvents = {
  peers: readonly PeerInfo[];
  /** Um peer atingiu estado terminal e foi removido. */
  dropped: { peerId: string };
};

export type MeshTopologyDeps = {
  readonly iceServers: readonly IceServerConfig[];
  readonly send: (payload: unknown, to: string) => void;
  readonly createConnection: (config: RTCConfiguration) => RTCPeerConnection;
  readonly maxPeers: number;
  readonly onIssue?: (peerId: string, code: PeerLinkIssueCode | PeerLinkFatalCode) => void;
  readonly onPeerStateChange?: (peerId: string, state: RTCPeerConnectionState) => void;
};

/**
 * Quanto a captura precisa encolher para caber no preset.
 *
 * A trilha é capturada na resolução do preset ESCOLHIDO e congelada ali. Quando
 * a degradação desce um degrau, é este fator que faz o encoder trabalhar menos
 * pixel de verdade — `maxBitrate` sozinho só aperta o QP.
 *
 * `1` quando não há o que encolher: `scaleResolutionDownBy` menor que 1 é
 * inválido, e aumentar resolução acima da captura não existe.
 */
function escalaPara(track: MediaStreamTrack | null, preset: EncodingPreset): number {
  const { width: alvoW, height: alvoH } = preset;
  const settings = track?.getSettings?.();
  const w = settings?.width ?? 0;
  const h = settings?.height ?? 0;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 1;
  if (alvoW <= 0 || alvoH <= 0) return 1;

  /**
   * O MAIOR dos dois fatores, e a altura entrou depois de custar 11% de bpp.
   *
   * Olhava só a largura. Numa tela 16:10 — 1920×1200, comuníssima em notebook
   * — `atual (1920) <= alvo (1920)` devolvia escala 1, e o encoder recebia
   * 2.304.000 pixels por quadro enquanto `effectiveBitrate` orçou para
   * 2.073.600. Onze por cento a menos de bits por pixel do que a conta
   * prometeu, em silêncio.
   *
   * Pelo maior fator, o lado que estoura é quem manda, e o quadro codificado
   * nunca passa do orçamento em nenhuma das duas dimensões.
   */
  return Math.max(1, Math.max(w / alvoW, h / alvoH));
}

/**
 * Teto de tentativas de `setParameters` por sender.
 *
 * Um navegador que recusa sempre não vai passar a aceitar na centésima vez, e
 * insistir por segundo até o fim da transmissão trocaria um defeito silencioso
 * por um barulhento.
 */
const MAX_TENTATIVAS_PARAMS = 3;

/** Áudio de jogo, não de voz: 128 kbps preserva música e efeitos. */
const AUDIO_BITRATE = 128_000;

/**
 * Quantas amostras um sender de áudio pode esperar pela negociação.
 *
 * Sem encoding negociado não há o que configurar, e isso NÃO é falha: é
 * cedo. Contar a espera como tentativa esgotava as três em três segundos e
 * deixava o áudio no default de voz para sempre. Trinta segundos cobrem uma
 * renegociação lenta; depois disso, algo está errado e insistir não ajuda.
 */
const MAX_ESPERA_NEGOCIACAO = 30;

/**
 * O que foi pedido ao sender de áudio e o que ele aceitou.
 *
 * Existe para o produto não afirmar "128 kbps" quando o `setParameters`
 * recusou — e para o diagnóstico dizer POR QUE recusou, com o nome do erro e
 * nada além.
 */
export type ConfigAudio = {
  readonly estado: 'aplicado' | 'aguardando' | 'pendente' | 'desistiu';
  /** O `maxBitrate` lido de volta depois de aplicar. É teto, não consumo. */
  readonly maxBitrate: number | null;
  /** `networkPriority` alto aceito. Opcional: recusa aqui não impede o resto. */
  readonly prioridade: boolean;
  /** Nome do último erro (`InvalidModificationError`…). Nunca a mensagem. */
  readonly erro: string | null;
};

/** Resumo coletivo: um peer que recusa não some na média dos outros. */
export type ResumoConfigAudio = {
  readonly senders: number;
  readonly aplicados: number;
  readonly comPrioridade: number;
  readonly aguardando: number;
  readonly pendentes: number;
  readonly desistiu: number;
  /** O teto comum; `null` quando não há aplicado ou quando divergem. */
  readonly maxBitrate: number | null;
  readonly ultimoErro: string | null;
};

function nomeDoErro(erro: unknown): string {
  const nome = erro instanceof Error ? erro.name : null;
  return nome !== null && /^[A-Za-z]{1,48}$/.test(nome) ? nome : 'Error';
}

export class MeshTopology {
  private readonly emitter = new Emitter<TopologyEvents>();
  private readonly links = new Map<string, PeerLink>();
  private readonly senders = new Map<string, RTCRtpSender[]>();
  private readonly relayed = new Set<string>();

  /** Trilhas publicadas, reaplicadas em todo peer que entra depois. */
  private stream: MediaStream | null = null;
  private tracks: MediaStreamTrack[] = [];
  private preset: EncodingPreset | null = null;

  /**
   * Espectadores que chegaram antes de existir mídia.
   *
   * Sem esta fila, um `peer-joined` que caísse na janela entre abrir o canal e
   * publicar a primeira trilha era perdido em silêncio, e o espectador ficava
   * em "conectando" para sempre (ADR 0006, A1).
   */
  private readonly waiting = new Set<string>();

  /**
   * Uma renegociação por peer, em fila.
   *
   * Duas chamadas concorrentes na mesma `RTCPeerConnection` se intercalavam e
   * uma delas retomava num objeto já fechado — `InvalidStateError` (ADR 0006,
   * A3). O gatilho é real: a queda automática por CPU e um clique manual no
   * seletor de qualidade podem cair no mesmo instante.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * O que o link comporta POR ESPECTADOR, medido. `null` antes da medição.
   *
   * Não é um teto: é o orçamento. O preset diz qual RESOLUÇÃO cabe; este
   * número diz quantos bits há para gastar nela.
   */
  private orcamento: number | null = null;

  private prioridade: Prioridade = 'fluidez';

  /**
   * Começa com o que veio do canal, mas NÃO é fixo: o canal reabre com
   * credenciais de TURN novas e quem entrar depois precisa das novas.
   */
  private iceServers: readonly IceServerConfig[];
  private readonly attempts = new Map<string, string>();
  private readonly configurationFailed = new Set<string>();

  constructor(private readonly deps: MeshTopologyDeps) {
    this.iceServers = deps.iceServers;
  }

  /** Chamado quando o canal de sinalização reabre com credenciais novas. */
  setIceServers(iceServers: readonly IceServerConfig[]): void {
    this.iceServers = iceServers;
    for (const link of this.links.values()) {
      if (link.updateIceServers(iceServers)) this.configurationFailed.delete(link.peerId);
      else this.configurationFailed.add(link.peerId);
    }
  }

  restart(peerId: string): boolean {
    if (this.configurationFailed.has(peerId)) return false;
    return this.links.get(peerId)?.restartIce() ?? false;
  }
  mediaBytes(peerId: string): Promise<number | null> {
    return this.links.get(peerId)?.mediaBytes('outbound') ?? Promise.resolve(null);
  }

  rebuild(peerId: string): void {
    if (!this.links.has(peerId)) return;
    const attemptId = this.attempts.get(peerId);
    this.drop(peerId, false);
    if (attemptId !== undefined) this.attempts.set(peerId, attemptId);
    this.attach(peerId);
  }

  on<K extends keyof TopologyEvents>(
    event: K,
    handler: (payload: TopologyEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  get size(): number {
    return this.links.size;
  }

  get peers(): readonly PeerInfo[] {
    return [...this.links.values()].map((link) => ({
      id: link.peerId,
      connectionState: link.connectionState,
      usingRelay: this.relayed.has(link.peerId),
    }));
  }

  /** Chamado quando o servidor de sinalização anuncia um espectador. */
  admit(peerId: string, attemptId?: string): void {
    const existente = this.links.get(peerId);
    if (existente !== undefined) {
      if (attemptId !== undefined && this.attempts.get(peerId) !== attemptId) {
        this.attempts.set(peerId, attemptId);
        this.rebuild(peerId);
        return;
      }
      // A recuperação coordenada já cuida de um link falho da MESMA tentativa.
      if (this.deps.onPeerStateChange !== undefined) return;
      /**
       * Link saudável com este peer JÁ existe — não derrube.
       *
       * Quando o transmissor reabre o canal depois de uma queda, o servidor
       * reapresenta todos os espectadores que continuaram conectados. Tratar
       * essa reapresentação como "peer novo" destruiria exatamente as
       * conexões que sobreviveram ao servidor, que é a promessa da
       * arquitetura. Só recria o que já morreu.
       */
      if (existente.connectionState !== 'failed' && existente.connectionState !== 'closed') {
        return;
      }
      /**
       * Rede de segurança, não caminho quente: `onStateChange` já derruba o
       * link em `failed`/`closed`, então na prática nada que continue neste
       * mapa está morto. Fica porque o custo é uma comparação e a alternativa
       * é um peer preso para sempre se aquele callback falhar.
       */
      this.drop(peerId);
    }
    if (this.links.size >= this.deps.maxPeers) return;
    if (attemptId !== undefined) this.attempts.set(peerId, attemptId);

    if (this.stream === null || this.preset === null) {
      this.waiting.add(peerId);
      return;
    }
    this.attach(peerId);
  }

  private attach(peerId: string): void {
    const stream = this.stream;
    const preset = this.preset;
    if (stream === null || preset === null) return;

    // O transmissor é impolite: ele tem a mídia e não recua na colisão.
    const link = new PeerLink({
      peerId,
      polite: false,
      iceServers: this.iceServers,
      send: (payload) => this.deps.send(payload, peerId),
      createConnection: this.deps.createConnection,
      /**
       * Lido a cada descrição recebida, não fixado na criação: o alvo muda com
       * o degrau e com o teto de upload, e um peer que entra no meio de uma
       * transmissão já degradada precisa começar onde os outros estão — não em
       * 300 kbps, subindo sozinho por trinta segundos enquanto o quality
       * scaler derruba a resolução dele.
       */
      startBitrateBps: () => this.bitrateInicial(),
      onStateChange: (state) => {
        if (this.deps.onPeerStateChange !== undefined) this.deps.onPeerStateChange(peerId, state);
        else if (state === 'failed' || state === 'closed') this.drop(peerId);
        this.announce();
      },
      onIssue: (code) => this.deps.onIssue?.(peerId, code),
      onFatal: (code) => {
        this.deps.onIssue?.(peerId, code);
        this.drop(peerId);
      },
    });

    this.links.set(peerId, link);

    try {
      const senders = this.tracks.map((track) => link.addTrack(track, stream));
      this.senders.set(peerId, senders);
      /**
       * Enfileirado, não solto.
       *
       * `attach` vem do handler de `peer-joined`, fora da fila, e também de
       * dentro de `publish`, onde corria em paralelo com o `adaptAll` da linha
       * seguinte. Convergiam para o mesmo número por acidente — não há `await`
       * entre `getParameters` e `setParameters` —, e a primeira edição que
       * pusesse um transformaria isso no `InvalidStateError` da ADR 0006 A3.
       */
      void this.enqueue(() => this.applyPreset(senders, preset));
    } catch {
      // Falhar ao anexar deixaria uma conexão viva contando como espectador,
      // sem oferta nenhuma no ar (ADR 0006, A2).
      this.drop(peerId);
      return;
    }

    this.announce();
  }

  drop(peerId: string, notify = true): void {
    const link = this.links.get(peerId);
    this.waiting.delete(peerId);
    this.attempts.delete(peerId);
    this.configurationFailed.delete(peerId);
    if (link === undefined) return;
    link.close();
    this.links.delete(peerId);
    /**
     * Os senders deste peer saem TAMBÉM das duas filas de reaplicação.
     *
     * Ficavam para trás: referências fortes a `RTCRtpSender` de uma
     * `RTCPeerConnection` fechada, que seguram a PC inteira viva. E com
     * `pendentes.size > 0` todo segundo, `collectStats` enfileirava
     * `reaplicarPendentes` para chamar `getParameters`/`setParameters` em
     * senders mortos — trabalho por segundo na máquina que está com o jogo
     * aberto, e o gatilho do throw que abortava o lote.
     *
     * `pc.close()` NÃO anula `sender.track`, então o filtro por trilha viva de
     * `reaplicarPendentes` não pegava esses.
     */
    for (const sender of this.senders.get(peerId) ?? []) {
      this.pendentes.delete(sender);
      this.tentativasAnteriores.delete(sender);
      this.configAudio.delete(sender);
      this.esperasAudio.delete(sender);
    }
    this.senders.delete(peerId);
    this.relayed.delete(peerId);
    if (notify) this.emitter.emit('dropped', { peerId });
    this.announce();
  }

  async handleSignal(from: string, payload: unknown): Promise<void> {
    const link = this.links.get(from);
    if (link === undefined) return;
    try {
      await link.handleSignal(payload);
    } catch (error) {
      if (error instanceof PeerLinkError) this.deps.onIssue?.(from, error.code);
      this.drop(from);
    }
  }

  /**
   * Publica (ou republica) a mídia para todo mundo.
   *
   * Trilha adicionada DEPOIS que um peer já conectou também precisa chegar
   * nele. O caso real é o áudio: a captura de tela resolve primeiro, o áudio
   * do sink virtual vem uns instantes depois, e um espectador que entrou no
   * meio ficaria sem som para sempre — sem erro, sem aviso, só silêncio.
   *
   * `addTrack` numa conexão já estabelecida dispara `negotiationneeded`, e o
   * perfect negotiation do `PeerLink` cuida da renegociação.
   */
  publish(stream: MediaStream, tracks: readonly MediaStreamTrack[], preset: EncodingPreset): Promise<void> {
    this.stream = stream;
    this.tracks = [...tracks];
    this.preset = preset;

    return this.enqueue(async () => {
      // Quem estava esperando mídia entra agora.
      for (const peerId of [...this.waiting]) {
        this.waiting.delete(peerId);
        this.attach(peerId);
      }
      // Quem já estava conectado recebe o que ainda não tinha.
      for (const [peerId, link] of this.links) this.syncTracks(peerId, link, stream);
      await this.adaptAll(preset);
    });
  }

  /** Garante que este peer tem um sender para cada trilha publicada. */
  private syncTracks(peerId: string, link: PeerLink, stream: MediaStream): void {
    const senders = this.senders.get(peerId) ?? [];
    const enviadas = new Set(senders.map((sender) => sender.track).filter(Boolean));

    for (const track of this.tracks) {
      if (enviadas.has(track)) continue;
      try {
        senders.push(link.addTrack(track, stream));
      } catch {
        // Conexão fechando no meio. O `connectionstatechange` cuida do resto.
        return;
      }
    }
    this.senders.set(peerId, senders);
  }

  /**
   * Troca de qualidade sem renegociar.
   *
   * `setParameters` nos senders existentes não mexe no SDP — ninguém pisca, e
   * a corrida entre duas renegociações concorrentes deixa de existir na raiz.
   */
  setPreset(preset: EncodingPreset): Promise<void> {
    this.preset = preset;
    return this.enqueue(() => this.adaptAll(preset));
  }

  /**
   * Troca a trilha de vídeo em todos os peers, sem renegociar.
   *
   * `replaceTrack` opera no sender já negociado, então o SDP não muda e nada
   * do outro lado percebe — nem um piscar. Renegociar aqui derrubaria a
   * imagem de todo mundo a cada troca de janela.
   */
  replaceVideo(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    this.stream = stream;
    this.tracks = [track, ...this.tracks.filter((t) => t.kind !== 'video')];

    return this.enqueue(async () => {
      for (const senders of this.senders.values()) {
        for (const sender of senders) {
          if (sender.track?.kind !== 'video') continue;
          try {
            await sender.replaceTrack(track);
          } catch {
            // Peer fechando no meio da troca; o estado dele cuida do resto.
          }
        }
      }
      if (this.preset !== null) await this.adaptAll(this.preset);
    });
  }

  setPrioridade(prioridade: Prioridade): Promise<void> {
    this.prioridade = prioridade;
    const preset = this.preset;
    if (preset === null) return Promise.resolve();
    return this.enqueue(() => this.adaptAll(preset));
  }

  setOrcamento(bps: number | null): Promise<void> {
    this.orcamento = bps;
    const preset = this.preset;
    if (preset === null) return Promise.resolve();
    return this.enqueue(() => this.adaptAll(preset));
  }

  private async adaptAll(preset: EncodingPreset): Promise<void> {
    const alvo = [...this.senders.values()].flat();
    await Promise.all(alvo.map((sender) => this.applyPreset([sender], preset)));
  }

  /**
   * Parâmetros IDÊNTICOS em todo sender. Ver o bloco no topo do arquivo:
   * variar por peer multiplica encoders e rouba CPU do jogo.
   */
  private async applyPreset(senders: readonly RTCRtpSender[], preset: EncodingPreset): Promise<void> {
    for (const sender of senders) {
      if (sender.track?.kind === 'audio') {
        await this.applyAudioParams(sender);
        continue;
      }
      if (sender.track?.kind !== 'video') continue;

      /**
       * `getParameters()` dentro do `try`, e a falta disso abortava o LOTE.
       *
       * A chamada pode lançar num sender de conexão fechando — o caminho de
       * áudio logo acima já a envolvia, o que mostra que se sabia disso. Aqui
       * ela estava nua, dentro de um `for`: um throw no primeiro sender
       * descartava os seguintes em silêncio. E como `reaplicarPendentes`
       * esvazia a fila ANTES de chamar este método, os descartados nunca mais
       * voltavam — ficavam nos defaults do navegador, divergentes dos outros
       * peers, que é a violação da R5 que este arquivo existe para impedir.
       *
       * Pior: a rejeição subia pela fila e, no caminho `publish` →
       * `publishVideo`, virava `fail('TRANSPORT_FAILED')` — a transmissão
       * inteira morria porque um peer que já estava saindo lançou.
       */
      let params: RTCRtpSendParameters;
      try {
        params = sender.getParameters();
      } catch {
        this.marcarPendente(sender);
        continue;
      }
      /**
       * Sender sem `encodings` ainda: NÃO invente um.
       *
       * A spec (webrtc-pc §5.2) manda rejeitar `setParameters` quando
       * `parameters.encodings.length` difere de `[[SendEncodings]].length`.
       * O código antigo mandava `[{}]` para um sender que tinha zero, o que
       * pede `InvalidModificationError` — e como a rejeição era engolida, o
       * peer ficava com os DEFAULTS do browser para sempre: sem `maxBitrate`,
       * sem `maxFramerate`, sem `networkPriority`, sem `degradationPreference`.
       *
       * Isso é violação direta da R5: parâmetros diferentes entre peers fazem
       * o Chrome parar de reaproveitar o encoder, e viram N encoders 1080p60
       * disputando a GPU com o jogo.
       */
      if (!params.encodings?.length) {
        this.marcarPendente(sender);
        continue;
      }

      const escala = escalaPara(sender.track, preset);
      const encodings = params.encodings;
      encodings[0] = {
        /**
         * O único parâmetro que de fato tira PIXEL do encoder.
         *
         * Sem ele, trocar de preset em execução não mudava nada: a resolução é
         * fixada uma vez no `getDisplayMedia` e nunca mais. Descer a escada
         * baixava o bitrate mantendo 1920×1080 a 60fps — 124 milhões de pixels
         * por segundo com menos bits para cada um, ou seja, exatamente o
         * quadriculado que a escada existia para evitar. Medido: um teto de
         * 3 Mbps rendia 0,0241 bit por pixel, e "otimizar" o preset sem isto
         * levava a 0,0201. Menos bits, zero pixels a menos.
         *
         * Todos os peers recebem o mesmo fator, porque ele deriva do preset
         * (que é coletivo pela R5) e da trilha (que é uma só). A invariante do
         * encoder reaproveitado continua de pé.
         */
        ...encodings[0],
          /**
           * O ÚNICO parâmetro que de fato tira pixel do encoder — e ele
           * precisa vir DEPOIS do spread.
           *
           * Estava antes, e `{ a: 1, ...obj }` deixa `obj.a` vencer: o
           * `scaleResolutionDownBy` que o Chrome já tinha (1) sobrescrevia o
           * calculado a cada chamada. Confirmado em Chromium real — descer a
           * escada mudava o bitrate e mantinha 1920×1080@60, exatamente o
           * 0,0201 bit por pixel que o comentário abaixo diz querer evitar.
           * A correção existia no código e nunca entrou em vigor.
           *
           * Pior: um peer que entrasse DEPOIS da degradação recebia escala
           * 1.5 enquanto o antigo ficava em 1.0 — parâmetros divergentes,
           * violação da R5, e o Chrome parando de reaproveitar o encoder.
           *
           * O fake de sender do projeto não tem `getSettings`, então
           * `escalaPara` devolvia 1 em todos os testes e ninguém viu.
           */
          scaleResolutionDownBy: escala,
          maxBitrate: this.effectiveBitrate(preset),
          maxFramerate: this.framerate(preset),
          /**
           * `medium`, e a mudança de `low` foi deliberada.
           *
           * `networkPriority` vira marcação DSCP. A intenção original era
           * ceder passagem ao netcode do jogo — correto em rede CABEADA com
           * fila consciente (fq_codel, CAKE), onde `low` vira CS1 e o roteador
           * atende o jogo primeiro.
           *
           * Em Wi-Fi ele sai pela culatra. CS1 mapeia para a categoria WMM
           * AC_BK, "background", que NÃO é apenas menos prioritária: ela tem
           * parâmetros de contenção PIORES que o tráfego comum, espera mais
           * para transmitir e perde disputa para qualquer outra coisa no
           * mesmo ar. Perda em rajada durante um movimento rápido vira bloco
           * na tela até o próximo keyframe.
           *
           * A defesa contra bufferbloat que de fato funciona é o teto de
           * upload — nunca pedir mais do que o link aguenta. Essa continua de
           * pé, e é ela que protege o ping do jogo. O DSCP era um bônus que
           * dependia do roteador, e num dos dois meios ele cobrava caro.
           */
          networkPriority: 'medium',
        };
      try {
        await sender.setParameters({
          ...params,
          encodings,
          // O que ceder sob aperto: por padrão resolução, nunca framerate.
          degradationPreference: DEGRADATION_BY_PRIORITY[this.prioridade],
        } as RTCRtpSendParameters);
        this.aceitou(sender, escala);
      } catch {
        /**
         * `setParameters` É TUDO OU NADA: se a chamada rejeita, NADA foi
         * aplicado.
         *
         * A segunda tentativa refaz `getParameters()`, e sem isso ela era
         * garantidamente inútil: o Blink limpa `last_returned_parameters_` ao
         * ENTRAR em `setParameters`, então reusar o mesmo `params` fazia a
         * segunda chamada rejeitar com `InvalidStateError` antes de olhar o
         * conteúdo. O caminho de fallback escrito para "salvar o essencial"
         * não salvava nada.
         *
         * E ela MANTÉM o `degradationPreference`. A versão anterior o omitia
         * de propósito e tratava a perda como sucesso parcial — mas um sender
         * em `balanced` enquanto os outros estão em `maintain-framerate` é
         * divergência de parâmetro, e divergência faz o Chrome parar de
         * reaproveitar o encoder. Dois encoders 1080p60 disputando a GPU com o
         * jogo é pior que qualquer degrau a menos.
         */
        try {
          const frescos = sender.getParameters();
          if (!frescos.encodings?.length) throw new Error('sem encodings');
          frescos.encodings[0] = { ...frescos.encodings[0], ...encodings[0] };
          await sender.setParameters({
            ...frescos,
            degradationPreference: DEGRADATION_BY_PRIORITY[this.prioridade],
          } as RTCRtpSendParameters);
          this.aceitou(sender, escala);
        } catch {
          // Falhou duas vezes: fica na fila para a próxima amostra de stats.
          this.marcarPendente(sender);
        }
      }
    }
  }

  /**
   * Senders que ainda não aceitaram os parâmetros.
   *
   * `attach` chama `applyPreset` em fire-and-forget e é a ÚNICA chamada que um
   * peer recebe em regime estacionário — sem esta fila, um peer que falhasse
   * na primeira tentativa nunca mais seria configurado.
   *
   * O número é a contagem de tentativas. Sem teto, um sender que rejeita
   * sempre viraria uma chamada de `setParameters` por segundo para sempre —
   * trocar um defeito silencioso por um barulhento não é conserto.
   */
  private readonly pendentes = new Map<RTCRtpSender, number>();

  /**
   * Nova tentativa para quem ficou de fora, no ritmo das estatísticas.
   *
   * Aproveita o relógio que já existe em vez de criar outro: `collectStats`
   * roda uma vez por segundo enquanto há peer.
   */
  private async reaplicarPendentes(): Promise<void> {
    if (this.pendentes.size === 0 || this.preset === null) return;
    const alvo = [...this.pendentes.keys()].filter((sender) => sender.track !== null);
    this.pendentes.clear();
    if (alvo.length === 0) return;
    await this.applyPreset(alvo, this.preset);
  }

  /** Enfileira para nova tentativa, até o teto. Depois disso, desiste calado. */
  private marcarPendente(sender: RTCRtpSender): void {
    const tentativas = (this.tentativasAnteriores.get(sender) ?? 0) + 1;
    this.tentativasAnteriores.set(sender, tentativas);
    if (tentativas > MAX_TENTATIVAS_PARAMS) return;
    this.pendentes.set(sender, tentativas);
  }

  /** Sobrevive ao `clear()` da fila: é o histórico, não a fila. */
  private readonly tentativasAnteriores = new Map<RTCRtpSender, number>();

  /**
   * Parâmetros do áudio do jogo (TELA-008).
   *
   * 128 kbps porque o WebRTC assume voz e aperta demais por padrão — trilha
   * de jogo com música vira lata. O bitrate é o ajuste ESSENCIAL; a
   * prioridade de rede alta é opcional, e recusa dela não pode derrubar o
   * essencial. DTX e RED se negociam no SDP e ficam fora daqui.
   *
   * # O que mudou, e por quê
   *
   * A versão anterior mandava `encodings: [{}]` quando o sender ainda não
   * tinha encoding — o mesmo erro que o caminho de vídeo já tinha corrigido:
   * a spec rejeita `setParameters` que muda a cardinalidade, e a rejeição era
   * engolida. O áudio ficava no default de voz, calado, e nada registrava.
   *
   * Agora: sem encoding é ESPERA (reaplica no ritmo das estatísticas, até
   * `MAX_ESPERA_NEGOCIACAO`); rejeição é tentativa (até
   * `MAX_TENTATIVAS_PARAMS`, com `getParameters` fresco a cada uma, porque o
   * Blink invalida o anterior ao entrar em `setParameters`); e o resultado
   * fica em `configAudio` para o diagnóstico.
   */
  private async applyAudioParams(sender: RTCRtpSender): Promise<void> {
    let params: RTCRtpSendParameters;
    try {
      params = sender.getParameters();
    } catch (erro) {
      this.falhouAudio(sender, nomeDoErro(erro));
      return;
    }

    if (!params.encodings?.length) {
      this.aguardarNegociacao(sender);
      return;
    }

    // Áudio tem prioridade ALTA: se algo tem que ceder sob aperto de rede,
    // é a imagem. Vídeo picotado dá para acompanhar; som picotado, não.
    const completo = { maxBitrate: AUDIO_BITRATE, networkPriority: 'high' as const };
    try {
      params.encodings[0] = { ...params.encodings[0], ...completo };
      await sender.setParameters(params);
      this.aplicouAudio(sender, true);
      return;
    } catch (erro) {
      this.registrarAudio(sender, { erro: nomeDoErro(erro) });
    }

    /*
      Segunda chamada só com o essencial, e com parâmetros FRESCOS. Se a
      recusa foi da prioridade, o bitrate ainda entra; se foi do bitrate, a
      tentativa conta e a fila tenta de novo na próxima amostra.
    */
    try {
      const frescos = sender.getParameters();
      if (!frescos.encodings?.length) {
        this.aguardarNegociacao(sender);
        return;
      }
      frescos.encodings[0] = { ...frescos.encodings[0], maxBitrate: AUDIO_BITRATE };
      await sender.setParameters(frescos);
      this.aplicouAudio(sender, false);
    } catch (erro) {
      this.falhouAudio(sender, nomeDoErro(erro));
    }
  }

  /** O estado da configuração de áudio, por sender. Some junto com o peer. */
  private readonly configAudio = new Map<RTCRtpSender, ConfigAudio>();
  /** Esperas por negociação, separadas das tentativas: esperar não é falhar. */
  private readonly esperasAudio = new Map<RTCRtpSender, number>();

  private registrarAudio(sender: RTCRtpSender, mudanca: Partial<ConfigAudio>): void {
    const atual = this.configAudio.get(sender) ?? {
      estado: 'pendente', maxBitrate: null, prioridade: false, erro: null,
    };
    this.configAudio.set(sender, { ...atual, ...mudanca });
  }

  private aplicouAudio(sender: RTCRtpSender, prioridade: boolean): void {
    let efetivo: number | null = null;
    try {
      const lido = sender.getParameters().encodings?.[0]?.maxBitrate;
      efetivo = typeof lido === 'number' ? lido : null;
    } catch {
      // Sem leitura de volta, não se afirma o valor.
    }
    this.pendentes.delete(sender);
    this.tentativasAnteriores.delete(sender);
    this.esperasAudio.delete(sender);
    this.registrarAudio(sender, { estado: 'aplicado', maxBitrate: efetivo, prioridade });
  }

  private aguardarNegociacao(sender: RTCRtpSender): void {
    const esperas = (this.esperasAudio.get(sender) ?? 0) + 1;
    this.esperasAudio.set(sender, esperas);
    if (esperas > MAX_ESPERA_NEGOCIACAO) {
      this.pendentes.delete(sender);
      this.registrarAudio(sender, { estado: 'desistiu', erro: 'NoNegotiatedEncoding' });
      return;
    }
    this.pendentes.set(sender, this.pendentes.get(sender) ?? 0);
    this.registrarAudio(sender, { estado: 'aguardando' });
  }

  private falhouAudio(sender: RTCRtpSender, erro: string): void {
    this.marcarPendente(sender);
    const desistiu = !this.pendentes.has(sender);
    this.registrarAudio(sender, { estado: desistiu ? 'desistiu' : 'pendente', erro });
  }

  /** O que o áudio de fato aceitou, somando todos os peers. */
  resumoConfigAudio(): ResumoConfigAudio | null {
    const vivos = [...this.senders.values()]
      .flat()
      .filter((sender) => sender.track?.kind === 'audio');
    if (vivos.length === 0) return null;
    let aplicados = 0;
    let comPrioridade = 0;
    let aguardando = 0;
    let pendentes = 0;
    let desistiu = 0;
    let ultimoErro: string | null = null;
    const tetos = new Set<number>();
    for (const sender of vivos) {
      const c = this.configAudio.get(sender);
      if (c === undefined || c.estado === 'aguardando') aguardando += 1;
      else if (c.estado === 'aplicado') aplicados += 1;
      else if (c.estado === 'pendente') pendentes += 1;
      else desistiu += 1;
      if (c?.prioridade === true) comPrioridade += 1;
      if (c?.estado === 'aplicado' && c.maxBitrate !== null) tetos.add(c.maxBitrate);
      if (c?.erro != null) ultimoErro = c.erro;
    }
    return {
      senders: vivos.length,
      aplicados,
      comPrioridade,
      aguardando,
      pendentes,
      desistiu,
      maxBitrate: aplicados > 0 && tetos.size === 1 ? [...tetos][0]! : null,
      ultimoErro,
    };
  }

  /**
   * Quantos bits o encoder recebe, dado o degrau e o teto do link.
   *
   * Era `min(preset, teto)`, e o `min` desperdiçava banda depois da ADR 0015.
   * Agora quem escolhe o DEGRAU já é o orçamento: quando o teto vale 3 Mbps, a
   * sessão manda `p480p60`, cujo nominal é 2,5 Mbps. Aplicar o `min` jogaria
   * fora 500 kbps que o link comprovadamente entrega — e esses 500 kbps, num
   * quadro de 854×480, são a diferença entre 0,10 e 0,12 bit por pixel.
   *
   * Então o teto VENCE quando é maior: menos pixels, cada um melhor
   * codificado. O clamp em `BPP_TETO` é a rede de segurança — acima de
   * 0,20 bpp o retorno em movimento alto é desprezível, e mandar bits que não
   * viram qualidade é o mesmo que encher o cano do usuário de graça.
   */
  /**
   * Um sender aceitou os parâmetros. Três coisas, e duas faltavam.
   *
   * `tentativasAnteriores` era um contador VITALÍCIO: incrementado em
   * `marcarPendente` e nunca apagado no sucesso. Três rejeições transitórias
   * espalhadas por uma sessão de duas horas — troca de encoder HW→SW, uma
   * borda de renegociação — e aquele sender saía da fila para SEMPRE, sem
   * `maxBitrate`, sem escala, sem `degradationPreference`. Divergência
   * permanente, encoder duplicado, FPS do jogo.
   *
   * E a escala só é registrada AQUI. Estava sendo gravada na construção do
   * objeto de encoding, antes de saber se o `setParameters` aceitou: se todos
   * falhassem, `escalaAplicada` afirmava que a escala estava no ar e
   * `escalaMudou()` passava a devolver `false` — desligando justamente a rede
   * de segurança que ela é.
   */
  private aceitou(sender: RTCRtpSender, escala: number): void {
    this.pendentes.delete(sender);
    this.tentativasAnteriores.delete(sender);
    this.escalaAplicada = escala;
  }

  private effectiveBitrate(preset: EncodingPreset): number {
    /**
     * SEM medição, o teto é o útil — não o nominal do preset.
     *
     * Parecia prudente limitar em 12 Mbps até medir. Era o contrário: um
     * `maxBitrate` NUNCA causa afogamento sozinho, porque o alocador do WebRTC
     * entrega ao encoder `min(BWE, maxBitrate)` e o BWE é delay-based. O teto
     * protege contra o BWE superestimar; ele não empurra nada.
     *
     * O que ele faz, quando é baixo demais, é CEGAR o estimador: o
     * `AimdRateControl` tampa a estimativa em `1,5 × acked`, e `acked` não
     * passa do nosso teto. Com 12 Mbps de teto inicial, a primeira leitura
     * nunca podia passar de 18 Mbps, e o orçamento nunca de 13,5 — num link de
     * 800 Mbps. Os 24,9 Mbps do `BPP_TETO` eram inalcançáveis por construção
     * (ADR 0018).
     *
     * O bitrate INICIAL continua conservador: `x-google-start-bitrate` usa o
     * nominal enquanto não há medição, então o encoder não parte com um
     * estouro — ele sobe, e agora tem para onde.
     */
    if (this.orcamento === null) return this.tetoUtil(preset);

    /**
     * Gasta o orçamento na resolução escolhida, até o teto ÚTIL de bits por
     * pixel — e é o `min` que faltava nos dois sentidos.
     *
     * Para BAIXO, a versão anterior fazia `max(nominal, orçamento)`, que
     * furava o orçamento em modo `nitidez`: a 30fps o degrau escolhido pode
     * ter nominal de até o DOBRO do que o link paga, e `max` mandava o
     * nominal. Um orçamento de 3 Mbps virava 5,5 Mbps de demanda — o
     * afogamento que o governador existe para impedir, produzido por ele.
     *
     * Para CIMA, o caminho inteiro estava trancado atrás de `ceiling !== null`,
     * ou seja, atrás da ESCASSEZ. Quem tinha banda de sobra nunca era medido e
     * caía no nominal: 800 Mbps de link entregavam os 12 Mbps do rótulo, que
     * são 0,096 bit por pixel — o piso da ADR 0010, onde a imagem para de
     * quebrar, não onde ela fica boa (ADR 0017).
     *
     * `BPP_TETO` (0,20) é onde o bit deixa de virar imagem em movimento alto.
     * Em 1080p60 são 24,9 Mbps.
     */
    return Math.round(Math.min(this.orcamento, this.tetoUtil(preset)));
  }

  /** Onde o bit deixa de virar imagem em movimento alto: 0,20 bpp. */
  private tetoUtil(preset: EncodingPreset): number {
    /**
     * O NOMINAL do degrau, e não a resolução que o encoder produziu.
     *
     * Tentei usar a medida — o E2E em browser real mostrou que o *quality
     * scaler* do Chromium encolhe o quadro por cima do nosso
     * `scaleResolutionDownBy`, e que o produto acabava pagando 10 a 12 Mbps
     * por um quadro de 640×360. O desperdício é real.
     *
     * Mas realimentar a saída do encoder no teto DELE é uma espiral: teto
     * menor → o scaler encolhe mais → teto menor ainda. Medido no simulador:
     * os cenários com bits por pixel abaixo do piso saltaram de 65 para 570.
     *
     * A medida continua sendo usada onde não realimenta nada: `stats-sampler`
     * calcula o bpp exibido a partir de `frameWidth`/`frameHeight` reais, então
     * o console mostra a verdade mesmo quando ela é feia. Corrigir o
     * desperdício exige a ESCADA reagir à divergência entre nominal e real —
     * não o teto.
     */
    const { width, height } = preset;
    return Math.round(tetoDeBitrate(width, height, this.framerate(preset)));
  }

  /**
   * Por onde o encoder deve COMEÇAR. Diferente do teto, e de propósito.
   *
   * O teto pode ser o útil (24,9 Mbps em 1080p60) antes de qualquer medição,
   * porque teto não empurra. O bitrate inicial empurra: ele diz ao controle de
   * congestionamento para partir daquele valor em vez de sondar desde
   * 300 kbps. Mandar 24,9 Mbps num link desconhecido é um estouro de verdade.
   *
   * Então: o nominal calibrado enquanto não medimos, o orçamento depois.
   */
  bitrateInicial(): number | null {
    const preset = this.preset;
    if (preset === null) return null;
    if (this.orcamento === null) return preset.main.maxBitrate;
    return this.effectiveBitrate(preset);
  }

  /**
   * Framerate alvo: 60 em `fluidez`, 30 em `nitidez`.
   *
   * Cortar quadro é o que paga a resolução maior no modo nitidez. Antes o
   * `maxFramerate` vinha sempre do preset e a prioridade só trocava o
   * `degradationPreference` — pedia-se ao encoder para preservar detalhe sem
   * lhe dar bit nenhum a mais por quadro para fazer isso.
   */
  private framerate(preset: EncodingPreset): number {
    return Math.min(preset.main.maxFramerate, FRAMERATE_POR_PRIORIDADE[this.prioridade]);
  }

  /**
   * Bits por pixel do que está sendo pedido ao encoder. Diagnóstico puro.
   *
   * É o número que, quando cai abaixo de 0,10, prevê a imagem borrada — e o
   * único que dizia a verdade enquanto o rótulo dizia 1080p60.
   */
  bppAtual(): number | null {
    const preset = this.preset;
    if (preset === null) return null;
    const { width, height } = preset;
    return bitsPorPixel(this.effectiveBitrate(preset), width, height, this.framerate(preset));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }



  /**
   * A escala que os senders receberam da última vez.
   *
   * `escalaPara` lê `track.getSettings().width`, e esse valor pode não estar
   * pronto no instante em que o peer entra — trilha recém-criada reporta `0`
   * em alguns caminhos, e `escalaPara` devolve `1` por segurança. Um `1`
   * errado significa mandar 1920×1080 com o bitrate de um degrau menor, que é
   * literalmente a definição de quadriculado.
   *
   * O agravante é que nada corrigia: `applyPreset` só roda de novo em troca de
   * preset, de orçamento, de prioridade ou de trilha. Um sender que acertou o
   * `setParameters` com a escala errada não entra na fila de pendentes, e
   * ficava assim pelo resto da transmissão.
   */
  private escalaAplicada: number | null = null;

  /**
   * Reconfere a escala no relógio que já existe.
   *
   * Custa uma leitura de `getSettings` por segundo, e fecha a janela em que
   * uma medição prematura vira qualidade errada permanente.
   */
  private escalaMudou(): boolean {
    if (this.preset === null || this.tracks.length === 0) return false;
    const video = this.tracks.find((t) => t.kind === 'video') ?? null;
    const agora = escalaPara(video, this.preset);
    if (this.escalaAplicada === null) return false;
    // 1% de banda morta: `getSettings` pode oscilar no último dígito, e
    // reconfigurar o encoder por isso seria trocar um defeito por outro.
    return Math.abs(agora - this.escalaAplicada) / this.escalaAplicada > 0.01;
  }

  /**
   * UMA coleta de `getStats()` por peer, em paralelo — e o status de relay sai
   * do mesmo relatório.
   *
   * Eram DUAS por peer por segundo, em série: `collectStats` fazia uma e
   * `refreshRelayStatus`, chamado logo depois, fazia outra. Com cinco
   * espectadores eram dez `getStats()` sequenciais por segundo. `getStats()`
   * no Chrome não é barato — salta para a thread de rede e serializa centenas
   * de objetos — e isso rodava na máquina que está com o jogo aberto, que é o
   * recurso que o produto inteiro existe para proteger.
   *
   * O `announce()` também era incondicional, então a sessão fazia `setState`
   * com um array novo toda vez, forçando re-render do React uma vez por
   * segundo sem nada ter mudado.
   */
  async collectStats(
    isRelayed?: (report: RTCStatsReport) => boolean,
  ): Promise<readonly RelatorioDePeer[]> {
    // Enfileirado, nunca solto: dois `applyPreset` concorrentes no mesmo
    // sender foi o `InvalidStateError` da ADR 0006 A3.
    if (this.pendentes.size > 0) void this.enqueue(() => this.reaplicarPendentes());
    if (this.escalaMudou()) {
      const preset = this.preset;
      if (preset !== null) void this.enqueue(() => this.adaptAll(preset));
    }

    const colhidos = await Promise.all(
      [...this.links.values()].map(async (link) => {
        try {
          return { peerId: link.peerId, report: await link.stats() };
        } catch {
          return null; // peer saindo
        }
      }),
    );

    const reports: RelatorioDePeer[] = [];
    let mudou = false;
    for (const colhido of colhidos) {
      if (colhido === null) continue;
      reports.push(colhido);
      if (isRelayed === undefined) continue;

      const agora = isRelayed(colhido.report);
      if (agora === this.relayed.has(colhido.peerId)) continue;
      if (agora) this.relayed.add(colhido.peerId);
      else this.relayed.delete(colhido.peerId);
      mudou = true;
    }
    // Só quando muda de verdade: ver o bloco acima.
    if (mudou) this.announce();
    return reports;
  }

  close(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.senders.clear();
    this.relayed.clear();
    this.waiting.clear();
    this.pendentes.clear();
    this.tentativasAnteriores.clear();
    this.stream = null;
    this.tracks = [];
    this.preset = null;
    this.orcamento = null;
    this.escalaAplicada = null;
    this.emitter.clear();
  }

  private announce(): void {
    this.emitter.emit('peers', this.peers);
  }
}
