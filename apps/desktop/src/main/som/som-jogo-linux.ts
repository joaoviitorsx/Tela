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
 * alimenta uma FONTE virtual (`Audio/Source`), que ele lista e captura. O modo
 * "sistema" usa a mesma ideia sobre o monitor da saída padrão.
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
import {
  type Comando,
  criarEntradaDoJogo,
  criarEntradaDoSistema,
  criarSink,
  dump,
  FERRAMENTAS,
  moverParaSink,
  restaurarStream,
  versao,
} from './comandos-pw.js';
import {
  type AppComSom,
  alvoFixado,
  appsComSom,
  DESCRICAO_DA_ENTRADA_DO_JOGO,
  DESCRICAO_DA_ENTRADA_DO_SISTEMA,
  entradaPronta,
  type GrafoPw,
  lerGrafo,
  NOME_DA_CAPTURA_DO_JOGO,
  NOME_DA_CAPTURA_DO_SISTEMA,
  NOME_DA_ENTRADA_DO_JOGO,
  NOME_DA_ENTRADA_DO_SISTEMA,
  NOME_DO_RETORNO,
  NOME_DO_SINK,
  residuos,
  saidaAtual,
  saidaPadrao,
  streamsDoApp,
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
  matar(pid: number): void;
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
    const g = await this.grafo();
    if (g === null) return 0;
    const r = residuos(g);
    for (const pid of r.pids) this.efeitos.matar(pid);
    for (const s of r.streamsApontando) await this.efeitos.executar(restaurarStream(s, null));
    return r.pids.length + r.streamsApontando.length;
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

      let sink: Comando;
      try {
        sink = criarSink(alvo);
      } catch {
        // Nome de saída com caracteres que não passam como argumento: o
        // gerenciador escolhe a padrão, que é melhor que recusar.
        sink = criarSink(null);
      }
      if (this.subir(sink) === null) return this.desistir('INDISPONIVEL');
      if (!(await this.esperarSink())) {
        await this.derrubarNos();
        return this.desistir('FALHOU');
      }
      // O sink de pé e com retorno: agora a fonte que o Chromium enxerga.
      if (this.subir(criarEntradaDoJogo()) === null || !(await this.esperarEntrada(NOME_DA_ENTRADA_DO_JOGO, NOME_DA_CAPTURA_DO_JOGO))) {
        await this.derrubarNos();
        return this.desistir('FALHOU');
      }

      this.appId = app.id;
      this.appChave = `${app.nome}|${app.binario ?? ''}`;
      this.nomeDoApp = app.nome;
      this.movidos = new Map();
      // Só depois de TUDO pronto: mover antes deixaria o jogo sem destino se algo falhasse.
      await this.mover(g, app.streams);

      this.estado = { fase: 'ativo', app: app.nome, tocando: true, modo: 'jogo' };
      this.agendarVarredura();
      return { ok: true, value: { app: app.nome, descricao: DESCRICAO_DA_ENTRADA_DO_JOGO } };
    } catch {
      await this.restaurarTudo();
      await this.derrubarNos();
      return this.desistir('FALHOU');
    }
  }

  /**
   * "Sistema" no Linux: o monitor da saída padrão como fonte virtual. Nada é
   * movido — só se cria a fonte, e `parar()` a remove.
   */
  async iniciarSistema(saidas: SaidasDoJogoLinux): Promise<Result<{ readonly descricao: string }, ErroSomJogo>> {
    if (this.estado.fase !== 'ocioso') return { ok: false, error: 'OCUPADO' };
    this.estado = { fase: 'preparando' };
    this.saidas = saidas;
    try {
      const g = await this.grafo();
      if (g === null) return this.desistir('INDISPONIVEL');
      if (saidaPadrao(g) === null) return this.desistir('FALHOU');
      if (this.subir(criarEntradaDoSistema()) === null) return this.desistir('INDISPONIVEL');
      if (!(await this.esperarEntrada(NOME_DA_ENTRADA_DO_SISTEMA, NOME_DA_CAPTURA_DO_SISTEMA))) {
        await this.derrubarNos();
        return this.desistir('FALHOU');
      }
      this.nomeDoApp = 'sistema';
      this.movidos = new Map();
      this.estado = { fase: 'ativo', app: 'sistema', tocando: true, modo: 'sistema' };
      return { ok: true, value: { descricao: DESCRICAO_DA_ENTRADA_DO_SISTEMA } };
    } catch {
      await this.derrubarNos();
      return this.desistir('FALHOU');
    }
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
  private async esperarSink(): Promise<boolean> {
    for (let t = 0; t <= PRAZO_DO_SINK_MS; t += PASSO_DA_ESPERA_MS) {
      if (this.algumSaiu()) return false;
      const g = await this.grafo();
      if (g !== null) {
        const sink = g.nos.find((n) => n.nome === NOME_DO_SINK);
        const retorno = g.nos.find((n) => n.nome === NOME_DO_RETORNO);
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
      const r = await this.efeitos.executar(moverParaSink(s));
      if (r.codigo === 0) this.movidos.set(s, { stream: s, anterior });
    }
  }

  private agendarVarredura(): void {
    this.cancelarVarredura = this.efeitos.agendar(() => void this.varrer(), PERIODO_DA_VARREDURA_MS);
  }

  /**
   * Streams novos do jogo (um jogo abre e fecha streams o tempo todo) entram
   * no sink; streams que sumiram saem da conta. Se o pid mudou (o jogo foi
   * reaberto) o app é reencontrado por nome e binário.
   */
  private async varrer(): Promise<void> {
    this.cancelarVarredura = null;
    if (this.estado.fase !== 'ativo' || this.estado.modo !== 'jogo' || this.emVarredura) return;
    this.emVarredura = true;
    try {
      const g = await this.grafo();
      if (g !== null && this.estado.fase === 'ativo') {
        const excl = this.efeitos.pidsDoTela();
        let streams = streamsDoApp(g, this.appId, excl);
        if (streams.length === 0) {
          const outro = appsComSom(g, excl).find((a) => `${a.nome}|${a.binario ?? ''}` === this.appChave);
          if (outro !== undefined) {
            this.appId = outro.id;
            streams = outro.streams;
          }
        }
        const vivos = new Set(streams);
        for (const id of [...this.movidos.keys()]) if (!vivos.has(id)) this.movidos.delete(id);
        await this.mover(g, streams);
        const tocando = streams.length > 0;
        if (this.estado.fase === 'ativo' && this.estado.tocando !== tocando) {
          this.estado = { fase: 'ativo', app: this.nomeDoApp, tocando, modo: 'jogo' };
          this.saidas?.mudou?.(this.estado);
        }
      }
    } finally {
      this.emVarredura = false;
      if (this.estado.fase === 'ativo') this.agendarVarredura();
    }
  }

  /** O `pw-loopback` morreu sem ninguém pedir: restaura o que der e avisa. */
  private async aoSinkMorrer(): Promise<void> {
    if (this.estado.fase !== 'ativo' && this.estado.fase !== 'preparando') return;
    const saidas = this.saidas;
    const estavaAtivo = this.estado.fase === 'ativo';
    this.cancelarVarredura?.();
    this.cancelarVarredura = null;
    await this.restaurarTudo();
    // Se só um dos dois processos morreu, o outro ainda guarda um nó: derruba.
    await this.derrubarNos();
    this.estado = { fase: 'ocioso' };
    this.saidas = null;
    if (estavaAtivo) saidas?.encerrou({ motivo: 'SINK_CAIU' });
  }

  /** Devolve cada stream ao alvo que tinha — só os que ainda existem. */
  private async restaurarTudo(): Promise<void> {
    const g = await this.grafo();
    const existentes = g === null ? null : new Set(g.nos.map((n) => n.id));
    for (const m of this.movidos.values()) {
      // Stream que já saiu não tem o que restaurar; sem dump, tenta todos.
      if (existentes !== null && !existentes.has(m.stream)) continue;
      await this.efeitos.executar(restaurarStream(m.stream, m.anterior));
    }
    this.movidos = new Map();
  }

  private async derrubarNos(): Promise<void> {
    const filhos = this.filhos;
    if (filhos.length === 0) return;
    this.derrubando = true;
    try {
      // A fonte primeiro: ela lê do sink, e sumir o sink antes a deixaria órfã por um instante.
      for (const f of [...filhos].reverse()) if (!f.saiu) f.p.kill('SIGTERM');
      const passos = PRAZO_DO_SIGTERM_MS / PASSO_DA_ESPERA_MS;
      for (let i = 0; i < passos && filhos.some((f) => !f.saiu); i++) await this.efeitos.esperar(PASSO_DA_ESPERA_MS);
      for (const f of filhos) if (!f.saiu) f.p.kill('SIGKILL');
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
    // direto à saída real, sem passar um instante sem destino.
    await this.restaurarTudo();
    await this.derrubarNos();
    this.estado = { fase: 'ocioso' };
    this.saidas = null;
  }
}
