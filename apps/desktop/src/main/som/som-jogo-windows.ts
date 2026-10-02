/**
 * O som no Windows (D3, PLANO-desktop §4.1) — "só o jogo" e "sistema": o main
 * orquestra, o utility process captura.
 *
 *     main ──fork──► utility process ── addon C++ (WASAPI process loopback)
 *       │  controle (parentPort)            │ PCM float32 48 kHz, blocos de 10 ms
 *       └─ repassa a MessagePort ──────────► renderer (AudioWorklet)
 *
 * O main é só quem cria os processos e entrega a porta: o PCM não passa por
 * ele. Se o addon cair, cai o utility — o renderer vê o fim da fonte
 * (`encerrou`) e mostra "som do jogo parou" sem derrubar o vídeo.
 *
 * Os dois modos são o MESMO process loopback com um pid e um modo:
 *
 *  - **só o jogo**: `incluir` o pid do jogo escolhido;
 *  - **sistema**: `excluir` o pid do app de voz (`apps-de-voz.ts`) — tudo que
 *    toca, menos a call. O loopback exclui UMA árvore de processos por vez;
 *    a cada `PERIODO_DA_REAVALIACAO_MS` o main lista as sessões no MESMO
 *    utility e, se o app de voz mudou (o Discord abriu depois), pede `trocar`:
 *    a captura reabre com o alvo novo na mesma porta (um corte curto no som).
 *
 * Nunca cai em silêncio para outro som: sem addon ou com Windows antigo,
 * `disponibilidade()` diz por quê e a interface mostra as opções
 * desabilitadas com o motivo — o modo Sistema NÃO volta ao `loopback` do
 * Electron, que levaria a call junto.
 *
 * Tudo que toca o Electron (`utilityProcess`, `MessageChannelMain`) é
 * injetado: a máquina de estados roda nos testes com um utility de mentira.
 */
import type { Result } from '../captura-nativa.js';
import {
  appsDasSessoes,
  type CodigoDeErroDoUtilitario,
  type PedidoAoUtilitario,
  pidValido,
  type RespostaDoUtilitario,
  respostaValida,
} from './protocolo-utilitario.js';
import { type ErroSomJogo, type FimDoSomDoJogo, windowsSuportaLoopbackPorProcesso } from './protocolo-som.js';
import { alvoDaExclusao } from './apps-de-voz.js';

export type ProcessoUtilitario = {
  postMessage(mensagem: PedidoAoUtilitario, transferir?: readonly unknown[]): void;
  aoMensagem(ouvinte: (mensagem: unknown) => void): void;
  aoSair(ouvinte: (codigo: number | null) => void): void;
  kill(): boolean;
};

/** Um par de portas: uma vai ao utility, a outra ao renderer. `P` é o tipo da porta do Electron. */
export type CanalDePcm<P> = { readonly paraUtilitario: P; readonly paraRenderer: P; fechar(): void };

export type DepsDoSomWindows<P> = {
  /** Sobe o utility process. Pode lançar (arquivo ausente). */
  forkUtilitario(): ProcessoUtilitario;
  criarCanal(): CanalDePcm<P>;
  agendar(fn: () => void, ms: number): () => void;
  /** Pids do próprio Tela: o áudio dele não é "o jogo". */
  pidsDoTela(): ReadonlySet<number>;
  /** O processo principal do Tela: a raiz da árvore que o modo sistema exclui quando não há app de voz. */
  pidPrincipal(): number;
  /** `os.release()`. */
  release(): string;
  /** O `.node` está no pacote? Sem ele nem vale subir o utility. */
  addonPresente(): boolean;
};

export type AppDoWindows = { readonly id: string; readonly nome: string; readonly tocando: boolean; readonly caminho: string; readonly pid: number };

export type SaidasDoSomWindows = { readonly encerrou: (fim: FimDoSomDoJogo) => void };

export const PRAZO_DA_SONDA_MS = 8000;
export const PRAZO_DA_LISTAGEM_MS = 5000;
export const PRAZO_DA_ATIVACAO_MS = 6000;
/** De quanto em quanto tempo o modo sistema confere se o app de voz mudou. */
export const PERIODO_DA_REAVALIACAO_MS = 5000;
const PRAZO_DO_ENCERRAMENTO_MS = 1000;

const MOTIVOS: Record<string, string> = {
  ADDON_AUSENTE: 'O componente de áudio não carregou nesta instalação.',
  ATIVACAO_RECUSADA: 'O Windows recusou capturar o áudio desse programa.',
  PROCESSO_INVALIDO: 'Esse programa não está mais aberto.',
  FALHOU: 'O componente de áudio falhou.',
};

type FimDaCaptura = 'PROCESSO_ENCERROU' | 'DISPOSITIVO' | 'FALHOU';

/**
 * A conversa com UM utility vivo: um ouvinte só, um pedido por vez. O
 * `ProcessoUtilitario` não tem como remover ouvinte; o modo sistema pergunta
 * a cada 5 s por horas, e um ouvinte por pergunta seria um vazamento.
 */
class Conversa {
  private esperando: ((r: RespostaDoUtilitario) => boolean) | null = null;
  private aoFimDaCaptura: ((motivo: FimDaCaptura) => void) | null = null;
  private fimGuardado: FimDaCaptura | null = null;
  private saiu = false;
  private readonly aoSairDoProcesso: Array<() => void> = [];

  constructor(
    readonly proc: ProcessoUtilitario,
    private readonly agendar: (fn: () => void, ms: number) => () => void,
  ) {
    proc.aoMensagem((m) => {
      const r = respostaValida(m);
      if (r === null) return;
      if (r.t === 'fim') {
        if (this.aoFimDaCaptura === null) this.fimGuardado ??= r.motivo;
        else this.aoFimDaCaptura(r.motivo);
        return;
      }
      this.esperando?.(r);
    });
    proc.aoSair(() => {
      this.saiu = true;
      for (const o of this.aoSairDoProcesso.splice(0)) o();
    });
  }

  /**
   * Manda o pedido e espera a primeira resposta de um dos tipos `espera` (ou
   * um `erro`). `null` no prazo, com o utility morto ou com outro pedido em curso.
   */
  pedir(
    pedido: PedidoAoUtilitario,
    prazoMs: number,
    espera: readonly RespostaDoUtilitario['t'][],
    transferir?: readonly unknown[],
  ): Promise<RespostaDoUtilitario | null> {
    if (this.esperando !== null || this.saiu) return Promise.resolve(null);
    return new Promise((resolver) => {
      let pronto = false;
      const terminar = (r: RespostaDoUtilitario | null): void => {
        if (pronto) return;
        pronto = true;
        cancelar();
        this.esperando = null;
        resolver(r);
      };
      const cancelar = this.agendar(() => terminar(null), prazoMs);
      this.esperando = (r) => {
        if (r.t !== 'erro' && !espera.includes(r.t)) return false;
        terminar(r);
        return true;
      };
      this.aoSair(() => terminar(null));
      this.proc.postMessage(pedido, transferir);
    });
  }

  /** O fim da captura que o addon avisou (o jogo fechou, o dispositivo caiu…). */
  aoFim(ouvinte: (motivo: FimDaCaptura) => void): void {
    this.aoFimDaCaptura = ouvinte;
    if (this.fimGuardado !== null) ouvinte(this.fimGuardado);
  }

  aoSair(ouvinte: () => void): void {
    if (this.saiu) ouvinte();
    else this.aoSairDoProcesso.push(ouvinte);
  }
}

type Ativa<P> = {
  readonly conversa: Conversa;
  readonly canal: CanalDePcm<P>;
  readonly id: number;
  readonly modo: 'jogo' | 'sistema';
  /** O pid que a captura inclui (jogo) ou exclui (sistema). */
  alvo: number;
  cancelarReavaliacao: (() => void) | null;
  encerrada: boolean;
};

export class SomDoJogoWindows<P> {
  private sonda: Promise<{ readonly disponivel: boolean; readonly motivo: string | null }> | null = null;
  private ativa: Ativa<P> | null = null;
  private iniciando = false;
  private proximoId = 1;
  /** Os pids da última listagem: só um deles pode ser capturado (o renderer é uma página web). */
  private listados = new Set<number>();
  private nomes = new Map<number, string>();
  /** O executável de cada pid na última listagem: o pid sozinho não identifica o processo no tempo (S-08). */
  private caminhos = new Map<number, string>();

  constructor(private readonly deps: DepsDoSomWindows<P>) {}

  /**
   * Windows novo o bastante, `.node` no pacote e utility que carrega o addon.
   * Resposta guardada: a sonda sobe um processo, e a pergunta se repete a cada
   * abertura do seletor.
   */
  disponibilidade(): Promise<{ readonly disponivel: boolean; readonly motivo: string | null }> {
    this.sonda ??= this.sondar();
    return this.sonda;
  }

  private async sondar(): Promise<{ readonly disponivel: boolean; readonly motivo: string | null }> {
    if (!windowsSuportaLoopbackPorProcesso(this.deps.release())) {
      return { disponivel: false, motivo: 'Precisa do Windows 10 versão 2004 (build 19041) ou mais novo.' };
    }
    if (!this.deps.addonPresente()) return { disponivel: false, motivo: MOTIVOS['ADDON_AUSENTE'] ?? '' };
    const r = await this.perguntar({ t: 'sondar' }, PRAZO_DA_SONDA_MS, (x) => (x.t === 'sonda' ? x : null));
    if (r === null) return { disponivel: false, motivo: MOTIVOS['FALHOU'] ?? '' };
    return r.ok ? { disponivel: true, motivo: null } : { disponivel: false, motivo: MOTIVOS[r.erro] ?? '' };
  }

  /** Um utility descartável: pergunta uma coisa, espera a resposta (ou o prazo) e o encerra. */
  private perguntar<T>(pedido: PedidoAoUtilitario, prazoMs: number, aceitar: (r: RespostaDoUtilitario) => T | null): Promise<T | null> {
    let proc: ProcessoUtilitario;
    try {
      proc = this.deps.forkUtilitario();
    } catch {
      return Promise.resolve(null);
    }
    return new Promise<T | null>((resolver) => {
      let pronto = false;
      const terminar = (v: T | null): void => {
        if (pronto) return;
        pronto = true;
        cancelar();
        resolver(v);
        proc.kill();
      };
      const cancelar = this.deps.agendar(() => terminar(null), prazoMs);
      proc.aoMensagem((m) => {
        const r = respostaValida(m);
        if (r === null) return;
        const v = aceitar(r);
        if (v !== null) terminar(v);
        else if (r.t === 'erro') terminar(null);
      });
      proc.aoSair(() => terminar(null));
      proc.postMessage(pedido);
    });
  }

  /** Apps com sessão de áudio na saída padrão; vazio se o componente não respondeu. */
  async listar(): Promise<readonly AppDoWindows[]> {
    if (!(await this.disponibilidade()).disponivel) return [];
    const r = await this.perguntar({ t: 'listar' }, PRAZO_DA_LISTAGEM_MS, (x) => (x.t === 'sessoes' ? x.sessoes : null));
    const apps = appsDasSessoes(r ?? [], this.deps.pidsDoTela());
    this.listados = new Set(apps.map((a) => a.pid));
    this.nomes = new Map(apps.map((a) => [a.pid, a.nome]));
    this.caminhos = new Map(apps.map((a) => [a.pid, a.caminho]));
    return apps;
  }

  async iniciar(
    appId: string,
    saidas: SaidasDoSomWindows,
  ): Promise<Result<{ readonly app: string; readonly id: number; readonly porta: P }, ErroSomJogo>> {
    if (this.ativa !== null || this.iniciando) return { ok: false, error: 'OCUPADO' };
    const m = /^pid:(\d+)$/.exec(appId);
    const pid = m === null ? NaN : Number(m[1]);
    if (!pidValido(pid)) return { ok: false, error: 'APP_NAO_ENCONTRADO' };
    // Só o que o seletor ofereceu — um pid inventado pela página não é capturado.
    if (!this.listados.has(pid)) return { ok: false, error: 'APP_NAO_ENCONTRADO' };
    if (!(await this.disponibilidade()).disponivel) return { ok: false, error: 'INDISPONIVEL' };

    this.iniciando = true;
    /*
      S-08: o seletor pode ficar aberto por minutos. Se o jogo fechou e o
      Windows reaproveitou o pid (para a call de voz, por exemplo), capturar
      esse pid transmitiria o áudio de OUTRO programa. Logo antes de capturar,
      pergunta de novo: o pid ainda tem sessão de áudio E o MESMO executável
      da listagem? Senão, recusa. É mitigação, não fechamento: sobra a janela
      de milissegundos entre esta pergunta e o `OpenProcess` do addon, e o
      mesmo executável reaberto com o mesmo pid (o mesmo jogo) é inofensivo. O
      fechamento é conferir o tempo de criação no addon (`GetProcessTimes`,
      PLANO/revisão S-08), que pede Windows para compilar e testar.
    */
    const esperado = this.caminhos.get(pid);
    const fresca = await this.perguntar({ t: 'listar' }, PRAZO_DA_LISTAGEM_MS, (x) => (x.t === 'sessoes' ? x.sessoes : null));
    const agora = fresca?.find((x) => x.pid === pid);
    if (agora === undefined || esperado === undefined || !mesmoExecutavel(agora.caminho, esperado)) {
      this.iniciando = false;
      this.listados.delete(pid);
      return { ok: false, error: 'APP_NAO_ENCONTRADO' };
    }

    const nome = this.nomes.get(pid) ?? `Programa ${pid}`;
    const r = await this.abrir('jogo', saidas, () => Promise.resolve(pid));
    return r.ok ? { ok: true, value: { app: nome, id: r.value.id, porta: r.value.porta } } : r;
  }

  /**
   * "Sistema": tudo que toca, MENOS a call. Lista as sessões no próprio
   * utility que vai capturar, escolhe o app de voz a excluir
   * (`alvoDaExclusao`) e abre o loopback em modo `excluir`. Ao vivo, reavalia
   * o alvo a cada `PERIODO_DA_REAVALIACAO_MS`.
   */
  async iniciarSistema(saidas: SaidasDoSomWindows): Promise<Result<{ readonly id: number; readonly porta: P }, ErroSomJogo>> {
    if (this.ativa !== null || this.iniciando) return { ok: false, error: 'OCUPADO' };
    this.iniciando = true;
    if (!(await this.disponibilidade()).disponivel) {
      this.iniciando = false;
      return { ok: false, error: 'INDISPONIVEL' };
    }
    // Sem listagem (utility mudo), exclui o próprio Tela: a reavaliação acha a call depois.
    return this.abrir('sistema', saidas, async (conversa) => (await this.alvoDoSistema(conversa)) ?? this.deps.pidPrincipal());
  }

  /** O pid a excluir agora, pelas sessões que o utility vê; `null` se ele não respondeu. */
  private async alvoDoSistema(conversa: Conversa): Promise<number | null> {
    const r = await conversa.pedir({ t: 'listar' }, PRAZO_DA_LISTAGEM_MS, ['sessoes']);
    if (r?.t !== 'sessoes') return null;
    return alvoDaExclusao(r.sessoes, this.deps.pidsDoTela(), this.deps.pidPrincipal()).pid;
  }

  /**
   * Sobe o utility, descobre o alvo (`alvo` pode perguntar ao próprio utility)
   * e abre a captura. Chamado com `iniciando` ligado; desliga ao sair.
   */
  private async abrir(
    modo: 'jogo' | 'sistema',
    saidas: SaidasDoSomWindows,
    alvo: (conversa: Conversa) => Promise<number>,
  ): Promise<Result<{ readonly id: number; readonly porta: P }, ErroSomJogo>> {
    let proc: ProcessoUtilitario;
    let canal: CanalDePcm<P>;
    try {
      proc = this.deps.forkUtilitario();
      canal = this.deps.criarCanal();
    } catch {
      this.iniciando = false;
      return { ok: false, error: 'INDISPONIVEL' };
    }
    const conversa = new Conversa(proc, this.deps.agendar);
    const id = this.proximoId++;
    const pid = await alvo(conversa);

    const r = await conversa.pedir(
      { t: 'capturar', pid, modo: modo === 'jogo' ? 'incluir' : 'excluir' },
      PRAZO_DA_ATIVACAO_MS,
      ['capturando'],
      [canal.paraUtilitario],
    );
    this.iniciando = false;
    const erro = r === null || r.t === 'capturando' ? null : r.t === 'erro' ? ERRO_AO_ABRIR[r.erro] : 'FALHOU';
    // No sistema não há "programa escolhido" que sumiu: o app de voz fechou no meio, e é falha.
    const resultado = r?.t === 'capturando' ? 'ok' : erro === null || (erro === 'APP_NAO_ENCONTRADO' && modo === 'sistema') ? 'FALHOU' : erro;

    if (resultado !== 'ok') {
      canal.fechar();
      proc.kill();
      return { ok: false, error: resultado };
    }

    const ativa: Ativa<P> = { conversa, canal, id, modo, alvo: pid, cancelarReavaliacao: null, encerrada: false };
    this.ativa = ativa;
    // Depois de capturando, o que chega é o fim — ou a morte do utility.
    conversa.aoFim((motivo) => this.acabou(ativa, motivo === 'PROCESSO_ENCERROU' ? 'PROCESSO_ENCERROU' : 'COMPONENTE_CAIU', saidas));
    conversa.aoSair(() => this.acabou(ativa, 'COMPONENTE_CAIU', saidas));
    if (modo === 'sistema') this.agendarReavaliacao(ativa, saidas);
    return { ok: true, value: { id, porta: canal.paraRenderer } };
  }

  private agendarReavaliacao(ativa: Ativa<P>, saidas: SaidasDoSomWindows): void {
    if (ativa.encerrada) return;
    ativa.cancelarReavaliacao = this.deps.agendar(() => void this.reavaliar(ativa, saidas), PERIODO_DA_REAVALIACAO_MS);
  }

  /**
   * O amigo entrou na call depois de a transmissão começar: o Discord não
   * estava entre as sessões quando a captura abriu. Se o app de voz a excluir
   * mudou, a captura reabre com o alvo novo — na mesma porta, com um corte de
   * uma ativação (dezenas de ms) no som. Uma listagem que falha não muda nada;
   * uma troca que falha encerra (a página mostra "SEM SOM · …").
   */
  private async reavaliar(ativa: Ativa<P>, saidas: SaidasDoSomWindows): Promise<void> {
    ativa.cancelarReavaliacao = null;
    if (ativa.encerrada) return;
    const alvo = await this.alvoDoSistema(ativa.conversa);
    if (ativa.encerrada) return;
    if (alvo !== null && alvo !== ativa.alvo) {
      const r = await ativa.conversa.pedir({ t: 'trocar', pid: alvo, modo: 'excluir' }, PRAZO_DA_ATIVACAO_MS, ['capturando']);
      if (ativa.encerrada) return;
      if (r?.t !== 'capturando') {
        this.acabou(ativa, 'COMPONENTE_CAIU', saidas);
        return;
      }
      ativa.alvo = alvo;
    }
    this.agendarReavaliacao(ativa, saidas);
  }

  private acabou(ativa: Ativa<P>, motivo: FimDoSomDoJogo['motivo'], saidas: SaidasDoSomWindows): void {
    if (ativa.encerrada) return;
    ativa.encerrada = true;
    ativa.cancelarReavaliacao?.();
    ativa.cancelarReavaliacao = null;
    if (this.ativa === ativa) this.ativa = null;
    ativa.canal.fechar();
    ativa.conversa.proc.kill();
    saidas.encerrou({ motivo });
  }

  /** Para a captura e o utility. Quem pediu para parar não recebe `encerrou`. */
  async parar(): Promise<void> {
    const a = this.ativa;
    if (a === null) return;
    this.ativa = null;
    a.encerrada = true;
    a.cancelarReavaliacao?.();
    a.cancelarReavaliacao = null;
    a.conversa.proc.postMessage({ t: 'parar' });
    // Dá um instante para o addon liberar o dispositivo antes de matar o processo.
    await new Promise<void>((resolver) => {
      const cancelar = this.deps.agendar(resolver, PRAZO_DO_ENCERRAMENTO_MS);
      a.conversa.aoSair(() => {
        cancelar();
        resolver();
      });
    });
    a.canal.fechar();
    a.conversa.proc.kill();
  }

  /** O id da sessão ativa, para o main fechar a porta certa. */
  idAtivo(): number | null {
    return this.ativa?.id ?? null;
  }
}

/** O erro do utility ao abrir a captura, como a página o entende. */
const ERRO_AO_ABRIR: Record<CodigoDeErroDoUtilitario, ErroSomJogo> = {
  PROCESSO_INVALIDO: 'APP_NAO_ENCONTRADO',
  ADDON_AUSENTE: 'INDISPONIVEL',
  ATIVACAO_RECUSADA: 'FALHOU',
  FALHOU: 'FALHOU',
};

/** Caminhos do Windows não diferenciam caixa. */
function mesmoExecutavel(a: string, b: string): boolean {
  return a !== '' && a.toLowerCase() === b.toLowerCase();
}
