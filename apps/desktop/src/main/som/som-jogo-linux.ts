/**
 * "Só o jogo" no Linux, gerenciado pelo app (D3, PLANO-desktop §4).
 *
 * Evolui o roteiro manual da TELA-010 (`scripts/audio-linux.sh`): em vez de a
 * pessoa mandar o jogo para um sink no pavucontrol, o app cria o sink
 * "Tela-Jogo", move SÓ os streams do app escolhido para ele e devolve tudo ao
 * fim. O jogador segue ouvindo — o sink repassa para a saída real —, e o
 * Chromium captura o monitor do sink como um dispositivo de entrada. Nenhuma
 * ponte nativa.
 *
 *     jogo ──target.object──► tela_jogo (sink do pw-loopback)
 *                                 │ monitor ─► Tela-Jogo-Entrada (fonte virtual) ─► getUserMedia
 *                                 └ retorno ─► saída real (o que o jogador ouve)
 *
 * O Chromium não lista monitores de sink como dispositivo; por isso o monitor
 * alimenta uma FONTE virtual (`Audio/Source`), que ele lista e captura.
 *
 * O modo "sistema" monta o MESMO grafo com nomes próprios (Tela-Sistema) e
 * inverte a escolha: em vez de mover só o jogo, move TUDO que toca na saída
 * padrão menos a call (`apps-de-voz.ts`) e o próprio Tela. A call segue
 * tocando direto no fone de quem joga e nunca passa pelo sink — não há o que
 * vazar para quem assiste.
 *
 * Ciclo de vida:
 *
 *     ocioso ─iniciar─► preparando ─► ativo ─parar─► encerrando ─► ocioso
 *                           │ falha      │ pw-loopback morreu
 *                           └─► ocioso   └─► (restaura) ─► ocioso, avisa
 *
 * Reversível por construção: o sink e a fonte pertencem a processos
 * `pw-loopback`, então se o app cair eles somem juntos, e os streams — cujo alvo agora não existe —
 * voltam sozinhos ao padrão. O que fica é um metadado `target.object`
 * apontando para um sink que não existe; `limparResiduos` o apaga no próximo
 * início. Efeitos (executar, spawn, relógio) são injetados: a máquina é
 * testada com um PipeWire de mentira.
 */
import type { Result } from '../captura-nativa.js';
import { ehAppDeVozNoLinux } from './apps-de-voz.js';
import { type Comando, criarEntrada, criarSink, dump, FERRAMENTAS, moverParaSink, restaurarStream, versao } from './comandos-pw.js';
import {
  type AppComSom,
  alvoFixado,
  appsComSom,
  entradaPronta,
  type GrafoPw,
  lerGrafo,
  NOS_DO_JOGO,
  NOS_DO_SISTEMA,
  type NosDoModo,
  residuos,
  saidaAtual,
  saidaPadrao,
  streamsDoApp,
  streamsDoSistema,
} from './grafo-pw.js';
import type { ErroSomJogo, FimDoSomDoJogo } from './protocolo-som.js';

export type ResultadoDeComando = { readonly codigo: number | null; readonly saida: string };

/** O `pw-loopback` em execução: o sink vive enquanto ele viver. */
export type ProcessoDoSink = {
  kill(sinal: 'SIGTERM' | 'SIGKILL'): boolean;
  aoSair(ouvinte: (codigo: number | null) => void): void;
};

export type EfeitosLinux = {
  /** Roda e espera. Nunca lança: ferramenta ausente é `codigo: null`. */
  executar(c: Comando): Promise<ResultadoDeComando>;
  /** Sobe um processo que DONO de um nó (o sink, a fonte virtual). Pode lançar (binário ausente). */
  iniciarSink(c: Comando): ProcessoDoSink;
  agendar(fn: () => void, ms: number): () => void;
  esperar(ms: number): Promise<void>;
  /**
   * Encerra os `pw-loopback` que ESTE app subiu numa execução anterior e que o
   * `/proc` ainda confirma (S-12). Devolve quantos. Nunca usa pid do PipeWire.
   */
  encerrarOrfaos(): number;
  /** Pids do próprio Tela: o áudio dele não é "o jogo". */
  pidsDoTela(): ReadonlySet<number>;
};

export type EstadoDoJogoLinux =
  | { readonly fase: 'ocioso' }
  | { readonly fase: 'preparando' }
  | { readonly fase: 'ativo'; readonly app: string; readonly tocando: boolean; readonly modo: 'jogo' | 'sistema' }
  | { readonly fase: 'encerrando' };

export type SaidasDoJogoLinux = {
  /** O `pw-loopback` morreu com o jogo no ar: o som do jogo parou. */
  readonly encerrou: (fim: FimDoSomDoJogo) => void;
  /** Os streams do jogo sumiram ou voltaram (o jogo fechou, abriu outro nível…). */
  readonly mudou?: (estado: EstadoDoJogoLinux) => void;
};

export const PERIODO_DA_VARREDURA_MS = 1000;
const PRAZO_DO_SINK_MS = 3000;
const PASSO_DA_ESPERA_MS = 100;
const PRAZO_DO_SIGTERM_MS = 1500;

type Filho = { readonly p: ProcessoDoSink; saiu: boolean };

type Movido = { readonly stream: number; readonly anterior: { readonly valor: string; readonly tipo: string } | null };

export class SomDoJogoLinux {
  private estado: EstadoDoJogoLinux = { fase: 'ocioso' };
  /** Os processos donos do sink e da fonte virtual: qualquer um que morra é queda. */
  private filhos: Filho[] = [];
  /** Estamos derrubando os nós de propósito: a saída deles não é uma queda. */
  private derrubando = false;
  /** Os nomes do grafo montado: o do jogo ou o do sistema. */
  private nos: NosDoModo = NOS_DO_JOGO;
  private modo: 'jogo' | 'sistema' = 'jogo';
  private appId = '';
  private appChave = '';
  private nomeDoApp = '';
  private movidos = new Map<number, Movido>();
  private cancelarVarredura: (() => void) | null = null;
  private emVarredura = false;
  private saidas: SaidasDoJogoLinux | null = null;

  constructor(private readonly efeitos: EfeitosLinux) {}

  fase(): EstadoDoJogoLinux {
    return this.estado;
  }

  /** As três ferramentas existem? Sem tocar em nada: só `--version`. */
  async disponibilidade(): Promise<{ readonly disponivel: boolean; readonly motivo: string | null }> {
    const faltam: string[] = [];
    for (const f of Object.values(FERRAMENTAS)) {
      const r = await this.efeitos.executar(versao(f));
      if (r.codigo !== 0) faltam.push(f);
    }
    return faltam.length === 0
      ? { disponivel: true, motivo: null }
      : { disponivel: false, motivo: `Precisa do PipeWire (faltam: ${faltam.join(', ')}). No Fedora: pipewire-utils.` };
  }

  private async grafo(): Promise<GrafoPw | null> {
    const r = await this.efeitos.executar(dump());
    if (r.codigo !== 0) return null;
    try {
      return lerGrafo(JSON.parse(r.saida) as unknown);
    } catch {
      return null;
    }
  }

  /** Quem está tocando, para o seletor. `null` quando o PipeWire não respondeu. */
  async listar(): Promise<readonly AppComSom[] | null> {
    const g = await this.grafo();
    return g === null ? null : appsComSom(g, this.efeitos.pidsDoTela());
  }

  /**
   * Apaga o que uma execução anterior deixou: o `pw-loopback` órfão e os
   * metadados que ainda apontam para o sink. Chamado ao abrir o app, nunca
   * com uma sessão em curso.
   */
  async limparResiduos(): Promise<number> {
    if (this.estado.fase !== 'ocioso') return 0;
    // Antes de tudo, e sem depender do PipeWire responder: com o dono do sink
    // morto o stream já volta ao padrão; a chave apagada é só a limpeza.
    const orfaos = this.efeitos.encerrarOrfaos();
    const g = await this.grafo();
    if (g === null) return orfaos;
    const r = residuos(g);
    for (const s of r.streamsApontando) await this.efeitos.executar(restaurarStream(s, null));
    return orfaos + r.streamsApontando.length;
  }

  async iniciar(appId: string, saidas: SaidasDoJogoLinux): Promise<Result<{ readonly app: string; readonly descricao: string }, ErroSomJogo>> {
    if (this.estado.fase !== 'ocioso') return { ok: false, error: 'OCUPADO' };
    this.estado = { fase: 'preparando' };
    this.saidas = saidas;
    try {
      const g = await this.grafo();
      if (g === null) return this.desistir('INDISPONIVEL');
      const app = appsComSom(g, this.efeitos.pidsDoTela()).find((a) => a.id === appId);
      if (app === undefined) return this.desistir('APP_NAO_ENCONTRADO');

      // A saída real do jogador: onde o primeiro stream toca agora. Se for a
      // padrão, o retorno SEGUE a padrão; se foi uma escolha dele, fica nela.
      const atual = saidaAtual(g, app.streams[0] ?? -1);
      const padrao = saidaPadrao(g)?.nome ?? null;
      const alvo = atual !== null && atual !== padrao ? atual : null;

      const montado = await this.montar(NOS_DO_JOGO, alvo);
      if (montado !== null) return this.desistir(montado);

      this.modo = 'jogo';
      this.appId = app.id;
      this.appChave = `${app.nome}|${app.binario ?? ''}`;
      this.nomeDoApp = app.nome;
      this.movidos = new Map();
      // Só depois de TUDO pronto: mover antes deixaria o jogo sem destino se algo falhasse.
      await this.mover(g, app.streams);

      this.estado = { fase: 'ativo', app: app.nome, tocando: true, modo: 'jogo' };
      this.agendarVarredura();
      return { ok: true, value: { app: app.nome, descricao: NOS_DO_JOGO.descricaoDaEntrada } };
    } catch {
      await this.restaurarTudo();
      await this.derrubarNos();
      return this.desistir('FALHOU');
    }
  }

  /**
   * "Sistema" no Linux: tudo que toca na saída padrão, MENOS a call. Sobe o
   * sink Tela-Sistema (com retorno que segue a saída padrão) e a fonte dele,
   * e move para lá todo stream que não é de app de voz nem do Tela. A
   * varredura de 1 s pega quem começar a tocar depois — e nunca a call.
   */
  async iniciarSistema(saidas: SaidasDoJogoLinux): Promise<Result<{ readonly descricao: string }, ErroSomJogo>> {
    if (this.estado.fase !== 'ocioso') return { ok: false, error: 'OCUPADO' };
    this.estado = { fase: 'preparando' };
    this.saidas = saidas;
    try {
      const g = await this.grafo();
      if (g === null) return this.desistir('INDISPONIVEL');
      if (saidaPadrao(g) === null) return this.desistir('FALHOU');

      // O retorno segue a padrão: é a saída cujo som vai ao ar.
      const montado = await this.montar(NOS_DO_SISTEMA, null);
      if (montado !== null) return this.desistir(montado);

      this.modo = 'sistema';
      this.appId = '';
      this.appChave = '';
      this.nomeDoApp = 'sistema';
      this.movidos = new Map();
      await this.mover(g, this.streamsDoSistema(g));

      this.estado = { fase: 'ativo', app: 'sistema', tocando: true, modo: 'sistema' };
      this.agendarVarredura();
      return { ok: true, value: { descricao: NOS_DO_SISTEMA.descricaoDaEntrada } };
    } catch {
      await this.restaurarTudo();
      await this.derrubarNos();
      return this.desistir('FALHOU');
    }
  }

  /**
   * Sobe o sink do modo, ESPERA o retorno ligado a uma saída, depois a fonte
   * virtual com a captura ligada. `null` quando tudo ficou de pé; senão o
   * erro, com os nós já derrubados — nada foi movido ainda.
   */
  private async montar(nos: NosDoModo, alvo: string | null): Promise<ErroSomJogo | null> {
    let sink: Comando;
    try {
      sink = criarSink(alvo, nos);
    } catch {
      // Nome de saída com caracteres que não passam como argumento: o
      // gerenciador escolhe a padrão, que é melhor que recusar.
      sink = criarSink(null, nos);
    }
    if (this.subir(sink) === null) return 'INDISPONIVEL';
    if (!(await this.esperarSink(nos))) {
      await this.derrubarNos();
      return 'FALHOU';
    }
    // O sink de pé e com retorno: agora a fonte que o Chromium enxerga.
    if (this.subir(criarEntrada(nos)) === null || !(await this.esperarEntrada(nos.entrada, nos.captura))) {
      await this.derrubarNos();
      return 'FALHOU';
    }
    this.nos = nos;
    return null;
  }

  private streamsDoSistema(g: GrafoPw): readonly number[] {
    return streamsDoSistema(g, NOS_DO_SISTEMA.sink, this.efeitos.pidsDoTela(), ehAppDeVozNoLinux);
  }

  private desistir(erro: ErroSomJogo): Result<never, ErroSomJogo> {
    this.estado = { fase: 'ocioso' };
    this.saidas = null;
    return { ok: false, error: erro };
  }

  /** Sobe um processo dono de um nó. `null` se o binário não existe. */
  private subir(comando: Comando): Filho | null {
    try {
      const p = this.efeitos.iniciarSink(comando);
      const filho: Filho = { p, saiu: false };
      this.filhos.push(filho);
      p.aoSair(() => {
        filho.saiu = true;
        // Saiu porque pedimos (parar, falha ao subir): quem pediu já cuida do resto.
        if (!this.derrubando && this.filhos.includes(filho)) void this.aoSinkMorrer();
      });
      return filho;
    } catch {
      return null;
    }
  }

  private algumSaiu(): boolean {
    return this.filhos.some((f) => f.saiu);
  }

  /** O sink existe e o retorno chegou numa saída — senão o jogador ficaria sem som. */
  private async esperarSink(nos: NosDoModo): Promise<boolean> {
    for (let t = 0; t <= PRAZO_DO_SINK_MS; t += PASSO_DA_ESPERA_MS) {
      if (this.algumSaiu()) return false;
      const g = await this.grafo();
      if (g !== null) {
        const sink = g.nos.find((n) => n.nome === nos.sink);
        const retorno = g.nos.find((n) => n.nome === nos.retorno);
        if (sink !== undefined && retorno !== undefined) {
          const ligado = g.links.some((l) => l.saida === retorno.id && g.nos.some((n) => n.id === l.entrada && n.classe === 'Audio/Sink'));
          if (ligado) return true;
        }
      }
      await this.efeitos.esperar(PASSO_DA_ESPERA_MS);
    }
    return false;
  }

  /** A fonte virtual existe e a captura dela está ligada — pronta para o Chromium. */
  private async esperarEntrada(nome: string, captura: string): Promise<boolean> {
    for (let t = 0; t <= PRAZO_DO_SINK_MS; t += PASSO_DA_ESPERA_MS) {
      if (this.algumSaiu()) return false;
      const g = await this.grafo();
      if (g !== null && entradaPronta(g, nome, captura)) return true;
      await this.efeitos.esperar(PASSO_DA_ESPERA_MS);
    }
    return false;
  }

  /** Move os streams ainda não movidos, guardando o alvo anterior de cada um. */
  private async mover(g: GrafoPw, streams: readonly number[]): Promise<void> {
    for (const s of streams) {
      if (this.movidos.has(s)) continue;
      const anterior = alvoFixado(g, s);
      const r = await this.efeitos.executar(moverParaSink(s, this.nos.sink));
      if (r.codigo === 0) this.movidos.set(s, { stream: s, anterior });
    }
  }

  private agendarVarredura(): void {
    this.cancelarVarredura = this.efeitos.agendar(() => void this.varrer(), PERIODO_DA_VARREDURA_MS);
  }

  /**
   * Streams novos (um jogo abre e fecha streams o tempo todo; no modo
   * sistema, qualquer programa que comece a tocar) entram no sink; streams
   * que sumiram saem da conta. No "só o jogo", se o pid mudou (o jogo foi
   * reaberto), o app é reencontrado por nome e binário.
   */
  private async varrer(): Promise<void> {
    this.cancelarVarredura = null;
    if (this.estado.fase !== 'ativo' || this.emVarredura) return;
    this.emVarredura = true;
    try {
      const g = await this.grafo();
      if (g !== null && this.estado.fase === 'ativo') {
        const streams = this.modo === 'sistema' ? this.streamsDoSistema(g) : this.streamsDoJogo(g);
        const vivos = new Set(streams);
        for (const id of [...this.movidos.keys()]) if (!vivos.has(id)) this.movidos.delete(id);
        await this.mover(g, streams);
        // O sistema não "para de tocar": sem nenhum stream, segue no ar em silêncio.
        const tocando = this.modo === 'sistema' || streams.length > 0;
        if (this.estado.fase === 'ativo' && this.estado.tocando !== tocando) {
          this.estado = { fase: 'ativo', app: this.nomeDoApp, tocando, modo: this.modo };
          this.saidas?.mudou?.(this.estado);
        }
      }
    } finally {
      this.emVarredura = false;
      if (this.estado.fase === 'ativo') this.agendarVarredura();
    }
  }

  private streamsDoJogo(g: GrafoPw): readonly number[] {
    const excl = this.efeitos.pidsDoTela();
    const streams = streamsDoApp(g, this.appId, excl);
    if (streams.length > 0) return streams;
    const outro = appsComSom(g, excl).find((a) => `${a.nome}|${a.binario ?? ''}` === this.appChave);
    if (outro === undefined) return streams;
    this.appId = outro.id;
    return outro.streams;
  }

  /** O `pw-loopback` morreu sem ninguém pedir: restaura o que der e avisa. */
  private async aoSinkMorrer(): Promise<void> {
    if (this.estado.fase !== 'ativo' && this.estado.fase !== 'preparando') return;
    const saidas = this.saidas;
    const estavaAtivo = this.estado.fase === 'ativo';
    this.cancelarVarredura?.();
    this.cancelarVarredura = null;
    try {
      await this.restaurarTudo();
    } finally {
      try {
        // Se só um dos dois processos morreu, o outro ainda guarda um nó: derruba.
        await this.derrubarNos();
      } finally {
        this.estado = { fase: 'ocioso' };
        this.saidas = null;
      }
    }
    if (estavaAtivo) saidas?.encerrou({ motivo: 'SINK_CAIU' });
  }

  /**
   * Devolve cada stream ao alvo que tinha — só os que ainda existem. NUNCA
   * lança (S-13): é chamado em `parar()` e na queda do sink, e uma exceção aqui
   * deixaria os streams num sink que some e o estado preso. Cada stream é
   * tratado à parte; um valor que `restaurarStream` recusa (metadado que outro
   * cliente gravou) cai para "apagar a chave", que devolve o stream ao padrão.
   */
  private async restaurarTudo(): Promise<void> {
    const movidos = [...this.movidos.values()];
    this.movidos = new Map();
    let existentes: Set<number> | null = null;
    try {
      const g = await this.grafo();
      existentes = g === null ? null : new Set(g.nos.map((n) => n.id));
    } catch {
      // sem dump, tenta todos
    }
    for (const m of movidos) {
      // Stream que já saiu não tem o que restaurar; sem dump, tenta todos.
      if (existentes !== null && !existentes.has(m.stream)) continue;
      try {
        let comando: Comando;
        try {
          comando = restaurarStream(m.stream, m.anterior);
        } catch {
          comando = restaurarStream(m.stream, null);
        }
        await this.efeitos.executar(comando);
      } catch {
        // um stream que não voltou não impede os outros
      }
    }
  }

  private async derrubarNos(): Promise<void> {
    const filhos = this.filhos;
    if (filhos.length === 0) return;
    this.derrubando = true;
    const sinal = (f: Filho, s: 'SIGTERM' | 'SIGKILL'): void => {
      try {
        f.p.kill(s);
      } catch {
        // o processo já tinha ido
      }
    };
    try {
      // A fonte primeiro: ela lê do sink, e sumir o sink antes a deixaria órfã por um instante.
      for (const f of [...filhos].reverse()) if (!f.saiu) sinal(f, 'SIGTERM');
      const passos = PRAZO_DO_SIGTERM_MS / PASSO_DA_ESPERA_MS;
      for (let i = 0; i < passos && filhos.some((f) => !f.saiu); i++) await this.efeitos.esperar(PASSO_DA_ESPERA_MS);
      for (const f of filhos) if (!f.saiu) sinal(f, 'SIGKILL');
    } finally {
      this.filhos = [];
      this.derrubando = false;
    }
  }

  /** Devolve o roteamento e remove o sink. Idempotente: parar o que já parou não faz nada. */
  async parar(): Promise<void> {
    if (this.estado.fase === 'ocioso' || this.estado.fase === 'encerrando') return;
    this.estado = { fase: 'encerrando' };
    this.cancelarVarredura?.();
    this.cancelarVarredura = null;
    // Restaurar ANTES de derrubar: com o sink ainda de pé, o stream volta
    // direto à saída real, sem passar um instante sem destino. `finally` em
    // cada degrau (S-13): passe o que passar, os nós caem e o estado volta a
    // `ocioso` — um `parar()` que lançasse deixaria todo `iniciar` seguinte em `OCUPADO`.
    try {
      await this.restaurarTudo();
    } finally {
      try {
        await this.derrubarNos();
      } finally {
        this.estado = { fase: 'ocioso' };
        this.saidas = null;
      }
    }
  }
}
