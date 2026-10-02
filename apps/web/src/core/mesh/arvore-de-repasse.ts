import { pisoDeBitrate } from '@tela/shared';
import {
  type DoAnfitriao,
  type DoEspectador,
  type RelatorioDoRepassador,
  VERSAO_DO_REPASSE,
} from './protocolo-de-repasse.js';

/**
 * A árvore da cascata de repasse, vista do anfitrião (ADR 0031, fase 1).
 *
 * Decide quem repassa para quem; não toca em mídia. O transporte liga as
 * pontas: `enviar` vai pelo signaling, `pausarVideo` mexe no sender do peer.
 *
 * # As regras da fase 1, e de onde vêm
 *
 * - **Um salto, no máximo** (resposta 3 do dono): repassador é sempre filho
 *   direto do anfitrião, e filho nunca repassa.
 * - **Pai pelo menor RTT** (resposta 3): entre os repassadores com vaga, o de
 *   menor RTT até o anfitrião. O RTT entre dois espectadores só existe depois
 *   de ligá-los; o até o anfitrião é o que se tem antes.
 * - **Liga sozinha** quando a malha não basta (resposta 5): o orçamento por
 *   caminho abaixo do piso do 720p60, ou a porta pela banda (ADR 0030) cheia.
 * - **Automático para quem tem banda** (resposta 4): todo repassador começa com
 *   UMA vaga e ganha outra só quando as arestas que já tem mostram folga — a
 *   subida não se mede antes de se usar.
 * - **K_MAX = 3** (E2): a CPU aguentaria 6, a estabilidade do quadro-chave não.
 * - **O anfitrião é o pai reserva**: o filho mantém a ligação com ele (o áudio
 *   continua vindo dali) e o anfitrião só pausa o vídeo DEPOIS que o filho diz
 *   que a imagem do pai chegou (`com-pai`). Se o pai falha, um `sem-pai` e o
 *   vídeo direto volta — nunca há um instante sem fonte de imagem planejado.
 * - **Sobrecarga se resolve devolvendo filho**, não descendo o degrau de todos:
 *   a malha coletiva (R5) continua olhando só os caminhos do anfitrião.
 */
export type DepsDaArvore = {
  readonly enviar: (mensagem: DoAnfitriao, para: string) => void;
  /** `true`: o vídeo deste peer passa a vir do pai; o anfitrião para de mandar. */
  readonly pausarVideo: (peerId: string, pausado: boolean) => void;
  readonly agora: () => number;
  /** As vagas de repasse mudaram: a capacidade do canal precisa ser refeita. */
  readonly aoMudarVagas?: () => void;
  /** Passou a haver (ou deixou de haver) filho de repassador: IDR periódico. */
  readonly aoMudarAtividade?: (ativa: boolean) => void;
};

/** Filhos por repassador. Ver o E2 na ADR 0031: estabilidade, não CPU. */
export const K_MAX = 3;
/** O piso do 720p60, por caminho: abaixo disto a malha já "não basta". */
export const LIMIAR_DO_REPASSE_BPS = pisoDeBitrate(1280, 720, 60);
/** Sem orçamento medido, a conta da folga usa isto como bitrate por caminho. */
const BITRATE_SEM_MEDIDA_BPS = 2_500_000;
/** Com menos espectadores do que isto a malha sempre basta. */
export const MIN_ESPECTADORES = 3;
/** Quem acabou de entrar ainda não tem RTT nem ICE assentado. */
export const ESTABILIZAR_MS = 5_000;
/** O filho tem este tempo para dizer que a imagem do pai chegou. */
export const PRAZO_DO_FILHO_MS = 8_000;
/** Intervalo mínimo entre duas vagas novas num mesmo repassador. */
export const SUBIDA_A_CADA_MS = 10_000;
/** Folga para ganhar vaga: a pior aresta acima disto × o bitrate. */
export const FOLGA_PARA_SUBIR = 1.25;
/** Abaixo disto × o bitrate, a pior aresta não aguenta: devolve um filho. */
export const FOLGA_PARA_DESCER = 0.85;
/** Falhas seguidas que tiram um repassador do jogo por um tempo. */
export const FALHAS_PARA_BLOQUEAR = 2;
export const BLOQUEIO_MS = 60_000;
/**
 * Uma aresta nova começa com a estimativa de banda baixa e sobe em segundos:
 * julgá-la antes disto devolveria todo filho recém-ligado.
 */
export const AQUECIMENTO_MS = 10_000;

type Espectador = {
  readonly id: string;
  podeRepassar: boolean;
  rttMs: number | null;
  readonly desde: number;
  /** O repassador deste filho; `null` = recebe do anfitrião. */
  pai: string | null;
  /** O pai confirmou a imagem: o vídeo direto está pausado. */
  confirmado: boolean;
  ligadoEm: number;
  /** Vagas concedidas como repassador (0 = não é repassador). */
  k: number;
  readonly filhos: Set<string>;
  relatorio: RelatorioDoRepassador | null;
  relatorioEm: number;
  ultimaSubida: number;
  /** Última vez que a árvore deste repassador mudou: um filho entrou ou confirmou. */
  mudouEm: number;
  falhas: number;
  bloqueadoAte: number;
};

export class ArvoreDeRepasse {
  private readonly espectadores = new Map<string, Espectador>();
  private orcamento: number | null = null;
  private portaCheia = false;
  private forcada = false;
  private atividade = false;
  private vagasAnunciadas = 0;

  constructor(private readonly deps: DepsDaArvore) {}

  /** Liga a cascata sem esperar a malha apertar. Só para teste de ponta a ponta. */
  forcar(): void {
    this.forcada = true;
  }

  /** O orçamento de vídeo POR caminho que a malha está usando (`setUplinkBudget`). */
  definirOrcamento(bps: number | null): void {
    this.orcamento = bps;
  }

  /** A porta pela banda (ADR 0030) não deixa mais ninguém entrar. */
  definirPortaCheia(cheia: boolean): void {
    this.portaCheia = cheia;
  }

  /** As vagas que os repassadores somam à sala, por cima das do anfitrião. */
  vagas(): number {
    let total = 0;
    for (const e of this.espectadores.values()) total += e.k;
    return total;
  }

  /** O pai de cada filho, para diagnóstico e teste. */
  paiDe(peerId: string): string | null {
    return this.espectadores.get(peerId)?.pai ?? null;
  }

  filhosDe(peerId: string): readonly string[] {
    return [...(this.espectadores.get(peerId)?.filhos ?? [])];
  }

  /** O vídeo direto deste peer está pausado (ele recebe do pai). */
  pausado(peerId: string): boolean {
    const e = this.espectadores.get(peerId);
    return e !== undefined && e.pai !== null && e.confirmado;
  }

  receber(de: string, msg: DoEspectador): void {
    const agora = this.deps.agora();
    switch (msg.repasse) {
      case 'estado': {
        if (msg.versao < VERSAO_DO_REPASSE) return;
        const e = this.espectadores.get(de);
        if (e === undefined) {
          this.espectadores.set(de, {
            id: de,
            podeRepassar: msg.podeRepassar,
            rttMs: msg.rttMs,
            desde: agora,
            pai: null,
            confirmado: false,
            ligadoEm: 0,
            k: 0,
            filhos: new Set(),
            relatorio: null,
            relatorioEm: 0,
            ultimaSubida: 0,
            mudouEm: 0,
            falhas: 0,
            bloqueadoAte: 0,
          });
          return;
        }
        e.rttMs = msg.rttMs;
        // Quem deixou de poder repassar (aba virou celular? não; mas o
        // navegador pode perder o transform) larga os filhos.
        if (e.podeRepassar && !msg.podeRepassar) this.aposentar(e);
        e.podeRepassar = msg.podeRepassar;
        return;
      }
      case 'relatorio': {
        const e = this.espectadores.get(de);
        if (e === undefined || e.k === 0) return;
        e.relatorio = msg;
        e.relatorioEm = agora;
        this.avaliarRepassador(e, agora);
        return;
      }
      case 'com-pai': {
        const e = this.espectadores.get(de);
        if (e === undefined || e.pai === null || e.confirmado) return;
        e.confirmado = true;
        // O primeiro filho de verdade conta como sucesso do repassador.
        const pai = this.espectadores.get(e.pai);
        if (pai !== undefined) {
          pai.falhas = 0;
          pai.mudouEm = agora;
        }
        this.deps.pausarVideo(de, true);
        return;
      }
      case 'sem-pai': {
        const e = this.espectadores.get(de);
        if (e === undefined || e.pai === null) return;
        const pai = this.espectadores.get(e.pai);
        this.devolver(e, true);
        if (pai !== undefined) this.registrarFalha(pai, agora);
        return;
      }
      case 'via': {
        // Só entre as duas pontas de uma aresta que o anfitrião criou: o hub
        // não é um canal livre entre espectadores.
        const origem = this.espectadores.get(de);
        const destino = this.espectadores.get(msg.para);
        if (origem === undefined || destino === undefined) return;
        if (origem.pai !== destino.id && destino.pai !== origem.id) return;
        this.deps.enviar({ repasse: 'via', de, dados: msg.dados }, msg.para);
        return;
      }
    }
  }

  /** O peer saiu da sala (ou da malha). */
  saiu(peerId: string): void {
    const e = this.espectadores.get(peerId);
    if (e === undefined) return;
    for (const filho of [...e.filhos]) {
      const f = this.espectadores.get(filho);
      if (f !== undefined) this.devolver(f, false);
    }
    if (e.pai !== null) {
      const pai = this.espectadores.get(e.pai);
      if (pai !== undefined) {
        pai.filhos.delete(peerId);
        this.deps.enviar({ repasse: 'soltar', filho: peerId }, pai.id);
      }
    }
    this.espectadores.delete(peerId);
    this.anunciar();
  }

  /** A cada ~2 s: prazos, folgas e, se a malha não basta, um filho novo. */
  tique(): void {
    const agora = this.deps.agora();

    // Filho que não confirmou a imagem do pai no prazo: a aresta não fechou
    // (ICE entre espectadores é a hipótese mais frágil da ADR). Volta direto.
    for (const e of this.espectadores.values()) {
      if (e.pai === null || e.confirmado || agora - e.ligadoEm < PRAZO_DO_FILHO_MS) continue;
      const pai = this.espectadores.get(e.pai);
      this.devolver(e, true);
      if (pai !== undefined) this.registrarFalha(pai, agora);
    }

    if (this.precisa()) this.ligarUm(agora);
    this.anunciar();
  }

  private precisa(): boolean {
    if (this.forcada) return true;
    if (this.espectadores.size < MIN_ESPECTADORES) return false;
    return this.portaCheia || (this.orcamento !== null && this.orcamento < LIMIAR_DO_REPASSE_BPS);
  }

  private bitrate(): number {
    return this.orcamento ?? BITRATE_SEM_MEDIDA_BPS;
  }

  /** Um filho por tique, no máximo: a árvore cresce devagar, sem reconstrução. */
  private ligarUm(agora: number): void {
    const assentado = (e: Espectador) => agora - e.desde >= ESTABILIZAR_MS;
    const livre = (e: Espectador) => agora >= e.bloqueadoAte;

    // Folhas candidatas: diretas, sem filhos, sem vaga de repassador. Primeiro
    // quem não pode repassar (não vai servir para outra coisa).
    const folhas = [...this.espectadores.values()]
      .filter((e) => e.pai === null && e.k === 0 && assentado(e))
      .sort((a, b) => Number(a.podeRepassar) - Number(b.podeRepassar) || (b.rttMs ?? 0) - (a.rttMs ?? 0));
    if (folhas.length === 0) return;

    const porRtt = (a: Espectador, b: Espectador) =>
      (a.rttMs ?? Number.POSITIVE_INFINITY) - (b.rttMs ?? Number.POSITIVE_INFINITY);
    let pai = [...this.espectadores.values()]
      .filter((e) => e.k > e.filhos.size && livre(e))
      .sort(porRtt)[0];

    if (pai === undefined) {
      // Ninguém com vaga: promove o candidato de menor RTT, se sobrar folha
      // para ele (promover alguém para ser pai de ninguém não alivia nada).
      const candidato = [...this.espectadores.values()]
        .filter((e) => e.podeRepassar && e.pai === null && e.k === 0 && assentado(e) && livre(e))
        .sort(porRtt)[0];
      if (candidato === undefined || !folhas.some((f) => f.id !== candidato.id)) return;
      candidato.k = 1;
      candidato.ultimaSubida = agora;
      pai = candidato;
    }

    const filho = folhas.find((f) => f.id !== pai.id);
    if (filho === undefined) return;
    filho.pai = pai.id;
    filho.confirmado = false;
    filho.ligadoEm = agora;
    pai.filhos.add(filho.id);
    pai.mudouEm = agora;
    this.deps.enviar({ repasse: 'filho', filho: filho.id }, pai.id);
    this.deps.enviar({ repasse: 'pai', pai: pai.id }, filho.id);
  }

  private avaliarRepassador(e: Espectador, agora: number): void {
    const r = e.relatorio;
    if (r === null || agora - e.mudouEm < AQUECIMENTO_MS) return;
    const b = this.bitrate();
    const apertado = r.sobrecarregado || (r.piorSaidaBps !== null && r.piorSaidaBps < FOLGA_PARA_DESCER * b);
    if (apertado) {
      if (e.filhos.size === 0) return;
      // Devolve o filho mais novo e encolhe a vaga para o que sobrou: sem
      // vaga sobrando, o próximo tique não religa ninguém aqui.
      const ultimo = [...e.filhos].at(-1);
      const filho = ultimo === undefined ? undefined : this.espectadores.get(ultimo);
      if (filho !== undefined) this.devolver(filho, true);
      e.k = e.filhos.size;
      e.ultimaSubida = agora;
      e.mudouEm = agora;
      // Sem filho nenhum, deixa de ser repassador por um tempo: promovê-lo de
      // novo no tique seguinte seria oscilar.
      if (e.k === 0) e.bloqueadoAte = agora + BLOQUEIO_MS;
      this.anunciar();
      return;
    }
    const folgado = !r.sobrecarregado && r.piorSaidaBps !== null && r.piorSaidaBps >= FOLGA_PARA_SUBIR * b;
    if (folgado && e.k < K_MAX && e.filhos.size >= e.k && agora - e.ultimaSubida >= SUBIDA_A_CADA_MS) {
      e.k += 1;
      e.ultimaSubida = agora;
      this.anunciar();
    }
  }

  /** O filho volta a receber do anfitrião. `avisarPai`: o pai ainda existe. */
  private devolver(filho: Espectador, avisarPai: boolean): void {
    const paiId = filho.pai;
    if (paiId === null) return;
    const pai = this.espectadores.get(paiId);
    pai?.filhos.delete(filho.id);
    if (avisarPai && pai !== undefined) this.deps.enviar({ repasse: 'soltar', filho: filho.id }, paiId);
    filho.pai = null;
    if (filho.confirmado) this.deps.pausarVideo(filho.id, false);
    filho.confirmado = false;
    this.deps.enviar({ repasse: 'pai', pai: null }, filho.id);
  }

  private aposentar(e: Espectador): void {
    for (const id of [...e.filhos]) {
      const f = this.espectadores.get(id);
      if (f !== undefined) this.devolver(f, true);
    }
    e.k = 0;
  }

  private registrarFalha(e: Espectador, agora: number): void {
    e.falhas += 1;
    if (e.falhas < FALHAS_PARA_BLOQUEAR) {
      // Religar na hora repetiria a mesma aresta com o mesmo ICE: um prazo de
      // espera antes de tentar de novo.
      e.k = Math.max(e.filhos.size, Math.min(e.k, 1));
      e.bloqueadoAte = agora + PRAZO_DO_FILHO_MS;
      return;
    }
    this.aposentar(e);
    e.falhas = 0;
    e.bloqueadoAte = agora + BLOQUEIO_MS;
  }

  private anunciar(): void {
    const vagas = this.vagas();
    if (vagas !== this.vagasAnunciadas) {
      this.vagasAnunciadas = vagas;
      this.deps.aoMudarVagas?.();
    }
    let ativa = false;
    for (const e of this.espectadores.values()) if (e.pai !== null) ativa = true;
    if (ativa !== this.atividade) {
      this.atividade = ativa;
      this.deps.aoMudarAtividade?.(ativa);
    }
  }
}
