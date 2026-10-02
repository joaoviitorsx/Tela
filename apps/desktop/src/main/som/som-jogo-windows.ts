/**
 * "Só o jogo" no Windows (D3, PLANO-desktop §4.1): o main orquestra, o utility
 * process captura.
 *
 *     main ──fork──► utility process ── addon C++ (WASAPI process loopback)
 *       │  controle (parentPort)            │ PCM float32 48 kHz, blocos de 10 ms
 *       └─ repassa a MessagePort ──────────► renderer (AudioWorklet)
 *
 * O main é só quem cria os processos e entrega a porta: o PCM não passa por
 * ele. Se o addon cair, cai o utility — o renderer vê o fim da fonte
 * (`encerrou`) e mostra "som do jogo parou" sem derrubar o vídeo.
 *
 * Nunca cai em silêncio para o som do sistema: sem addon ou com Windows
 * antigo, `disponibilidade()` diz por quê e a interface mostra a opção
 * desabilitada com o motivo.
 *
 * Tudo que toca o Electron (`utilityProcess`, `MessageChannelMain`) é
 * injetado: a máquina de estados roda nos testes com um utility de mentira.
 */
import type { Result } from '../captura-nativa.js';
import {
  appsDasSessoes,
  type PedidoAoUtilitario,
  pidValido,
  type RespostaDoUtilitario,
  respostaValida,
} from './protocolo-utilitario.js';
import { type ErroSomJogo, type FimDoSomDoJogo, windowsSuportaLoopbackPorProcesso } from './protocolo-som.js';

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
const PRAZO_DO_ENCERRAMENTO_MS = 1000;

const MOTIVOS: Record<string, string> = {
  ADDON_AUSENTE: 'O componente de áudio do jogo não carregou nesta instalação.',
  ATIVACAO_RECUSADA: 'O Windows recusou capturar o áudio desse programa.',
  PROCESSO_INVALIDO: 'Esse programa não está mais aberto.',
  FALHOU: 'O componente de áudio do jogo falhou.',
};

type Ativa<P> = {
  readonly proc: ProcessoUtilitario;
  readonly canal: CanalDePcm<P>;
  readonly id: number;
  readonly app: string;
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

    let proc: ProcessoUtilitario;
    let canal: CanalDePcm<P>;
    try {
      proc = this.deps.forkUtilitario();
      canal = this.deps.criarCanal();
    } catch {
      this.iniciando = false;
      return { ok: false, error: 'INDISPONIVEL' };
    }
    const id = this.proximoId++;
    const nome = this.nomes.get(pid) ?? `Programa ${pid}`;

    const resultado = await new Promise<'ok' | ErroSomJogo>((resolver) => {
      let pronto = false;
      const terminar = (v: 'ok' | ErroSomJogo): void => {
        if (pronto) return;
        pronto = true;
        cancelar();
        resolver(v);
      };
      const cancelar = this.deps.agendar(() => terminar('FALHOU'), PRAZO_DA_ATIVACAO_MS);
      proc.aoMensagem((msg) => {
        const r = respostaValida(msg);
        if (r === null) return;
        if (r.t === 'capturando') terminar('ok');
        else if (r.t === 'erro') terminar(r.erro === 'PROCESSO_INVALIDO' ? 'APP_NAO_ENCONTRADO' : r.erro === 'ADDON_AUSENTE' ? 'INDISPONIVEL' : 'FALHOU');
      });
      proc.aoSair(() => terminar('FALHOU'));
      proc.postMessage({ t: 'capturar', pid }, [canal.paraUtilitario]);
    });
    this.iniciando = false;

    if (resultado !== 'ok') {
      canal.fechar();
      proc.kill();
      return { ok: false, error: resultado };
    }

    const ativa: Ativa<P> = { proc, canal, id, app: nome, encerrada: false };
    this.ativa = ativa;
    // Depois de capturando, o que chega é o fim — ou a morte do utility.
    proc.aoMensagem((msg) => {
      const r = respostaValida(msg);
      if (r?.t === 'fim') this.acabou(ativa, r.motivo === 'PROCESSO_ENCERROU' ? 'PROCESSO_ENCERROU' : 'COMPONENTE_CAIU', saidas);
    });
    proc.aoSair(() => this.acabou(ativa, 'COMPONENTE_CAIU', saidas));
    return { ok: true, value: { app: nome, id, porta: canal.paraRenderer } };
  }

  private acabou(ativa: Ativa<P>, motivo: FimDoSomDoJogo['motivo'], saidas: SaidasDoSomWindows): void {
    if (ativa.encerrada) return;
    ativa.encerrada = true;
    if (this.ativa === ativa) this.ativa = null;
    ativa.canal.fechar();
    ativa.proc.kill();
    saidas.encerrou({ motivo });
  }

  /** Para a captura e o utility. Quem pediu para parar não recebe `encerrou`. */
  async parar(): Promise<void> {
    const a = this.ativa;
    if (a === null) return;
    this.ativa = null;
    a.encerrada = true;
    a.proc.postMessage({ t: 'parar' });
    // Dá um instante para o addon liberar o dispositivo antes de matar o processo.
    await new Promise<void>((resolver) => {
      const cancelar = this.deps.agendar(resolver, PRAZO_DO_ENCERRAMENTO_MS);
      a.proc.aoSair(() => {
        cancelar();
        resolver();
      });
    });
    a.canal.fechar();
    a.proc.kill();
  }

  /** O id da sessão ativa, para o main fechar a porta certa. */
  idAtivo(): number | null {
    return this.ativa?.id ?? null;
  }
}

/** Caminhos do Windows não diferenciam caixa. */
function mesmoExecutavel(a: string, b: string): boolean {
  return a !== '' && a.toLowerCase() === b.toLowerCase();
}
