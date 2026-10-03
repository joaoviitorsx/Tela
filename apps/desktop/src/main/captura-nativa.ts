import { type EventoDoNativo, LeitorDoProtocolo, type QuadroDoNativo } from './protocolo-captura.js';

/**
 * O ciclo de vida do `tela-captura` (nativo/linux), visto pelo main
 * (D0c, docs/desktop/D2-captura.md).
 *
 * O processo captura pelo portal do sistema e codifica no NVENC; o main só
 * sobe, lê o protocolo, repassa ordens e mata. Tudo que é decisão fica aqui,
 * sem Electron e sem `child_process`: o `spawn` e o relógio são injetados,
 * para a máquina de estados ser testada com um processo de mentira.
 *
 * Estados de uma sessão:
 *
 *   iniciando ──pronto──► capturando ──parar()──► encerrando ──exit──► encerrado
 *       │                     │
 *      exit                  exit (o processo morreu, a fonte fechou…)
 *       ▼                     ▼
 *   err(motivo)          encerrou(fim) → o renderer encerra a captura
 *
 * Trocar de fonte é um `iniciar` com outra sessão já capturando: a nova sobe
 * primeiro e só quando chega ao `pronto` a antiga é parada em silêncio. Se a
 * pessoa cancelar o portal da nova, a antiga continua no ar — cancelar a
 * troca não pode derrubar a transmissão.
 */

export type ProcessoFilho = {
  readonly stdout: { on(evento: 'data', ouvinte: (pedaco: Buffer) => void): unknown };
  readonly stdin: { write(dados: string): unknown; end(): unknown };
  on(evento: 'exit', ouvinte: (codigo: number | null) => void): unknown;
  on(evento: 'error', ouvinte: (erro: Error) => void): unknown;
  kill(sinal?: 'SIGTERM' | 'SIGKILL'): boolean;
};

/** `setTimeout` injetável; devolve o cancelamento. */
export type Agendar = (fn: () => void, ms: number) => () => void;

export type DepsDaCapturaNativa = {
  /** Sobe o binário com estes argumentos. Pode lançar (binário ausente). */
  readonly spawn: (args: readonly string[]) => ProcessoFilho;
  readonly agendar: Agendar;
};

/** O que o renderer manda em `capturaNativa.iniciar` (cópia de `ponte.ts`). */
export type PedidoDeCapturaNativa = {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
};

export type ErroDaCapturaNativa =
  /** A pessoa fechou o portal: escolha, não falha (DENIED do lado de lá). */
  | 'CANCELADO'
  | 'SEM_NVENC'
  | 'SEM_COMPONENTE'
  | 'PORTAL'
  | 'PIPELINE'
  /** O processo morreu sem dizer por quê. */
  | 'MORREU'
  /** O binário não está aqui (AppImage sem ele, build sem o passo nativo). */
  | 'INDISPONIVEL'
  /** Já existe um `iniciar` esperando o portal. */
  | 'OCUPADO';

export type ProntoDaCaptura = {
  readonly id: number;
  readonly fonte: { readonly width: number; readonly height: number };
  /** `dmabuf` (GPU) ou `sistema` (memória): diagnóstico. */
  readonly memoria: string;
  /** O token do portal para a próxima transmissão não perguntar de novo. */
  readonly restaurar: string | null;
};

export type MotivoDoFim = 'FONTE_ENCERRADA' | 'PIPELINE' | 'PORTAL' | 'MORREU';

export type FimDaCapturaNativa = {
  readonly id: number;
  readonly motivo: MotivoDoFim;
  readonly codigo: number | null;
};

export type SaidasDaSessao = {
  readonly quadro: (q: QuadroDoNativo) => void;
  readonly captura: () => void;
  readonly evento: (e: EventoDoNativo) => void;
  /** O processo morreu enquanto capturava. Não é chamado depois de `parar`. */
  readonly encerrou: (fim: FimDaCapturaNativa) => void;
};

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Limites que cabem em `u16` do protocolo e no que um monitor entrega. */
const LADO_MAXIMO = 7680;
const FPS_MAXIMO = 240;
/** Teto de bitrate do `alvo`: 200 Mbps, bem acima do que o codificador da página pede. */
const BITRATE_MAXIMO = 200_000_000;

/**
 * O payload de `capturaNativa.iniciar` vindo do renderer. Inteiros pares no
 * tamanho (o NV12 exige), fps razoável. Qualquer outra coisa é recusada —
 * nada daqui vira argumento de processo sem passar por aqui.
 */
export function pedidoDeCapturaValido(payload: unknown): PedidoDeCapturaNativa | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const inteiro = (x: unknown, min: number, max: number): number | null =>
    typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : null;
  const width = inteiro(p['width'], 2, LADO_MAXIMO);
  const height = inteiro(p['height'], 2, LADO_MAXIMO);
  const fps = inteiro(p['fps'], 1, FPS_MAXIMO);
  if (width === null || height === null || fps === null) return null;
  return { width: width & ~1, height: height & ~1, fps };
}

/**
 * Bitrate inicial do processo, só até a primeira ordem `alvo` do codificador
 * (que chega logo que a sessão publica): 0,1 bit por pixel, o piso útil da
 * ADR 0010, para o primeiro IDR não sair quadriculado.
 */
export function bitrateInicial(p: PedidoDeCapturaNativa): number {
  return Math.min(25_000_000, Math.max(1_000_000, Math.round(p.width * p.height * p.fps * 0.1)));
}

export function argumentosDoHelper(p: PedidoDeCapturaNativa, restaurar: string | null): readonly string[] {
  const args = ['--fonte=portal', `--alvo=${p.width},${p.height},${p.fps},${bitrateInicial(p)}`];
  if (restaurar !== null && restaurar !== '') args.push(`--restaurar=${restaurar}`);
  return args;
}

/**
 * As ordens que o renderer pode mandar ao processo, e nada mais: a porta vem
 * de uma página web, e o stdin do processo não é lugar de texto livre.
 */
const ORDEM = /^(alvo \d{1,5} \d{1,5} \d{1,3} \d{1,9}|chave|atraso \d{1,3}|teto \d{1,3}|perfil (?:main|baseline)|taxa (?:vbr|cbr)|parar)$/;

/**
 * `teto <fps>`: o teto de fps da CAPTURA, independente do `alvo` (que é o do
 * encode). Existe para a ociosidade — sem espectador a sessão pede 5 fps e o
 * processo para de subir quadros ao NVENC. Não recicla o pipeline nem gera IDR.
 * Acima do fps do `alvo` (ou 0) é "sem teto".
 */
export function ordemValida(linha: unknown): string | null {
  if (typeof linha !== 'string' || !ORDEM.test(linha)) return null;
  // `\d{1,3}` aceita até 999; o processo só entende o que cabe num monitor.
  const teto = /^teto (\d+)$/.exec(linha);
  if (teto !== null && Number(teto[1]) > FPS_MAXIMO) return null;
  // `alvo` com os MESMOS tetos do `iniciar` (S-15): sem isto uma ordem
  // `alvo 99999 99999 …` chegava ao helper, que pediria dezenas de GB de VRAM ao GL.
  const alvo = /^alvo (\d+) (\d+) (\d+) (\d+)$/.exec(linha);
  if (alvo !== null) {
    const [largura, altura, fps, bitrate] = [alvo[1], alvo[2], alvo[3], alvo[4]].map(Number) as [number, number, number, number];
    if (largura < 2 || altura < 2 || largura > LADO_MAXIMO || altura > LADO_MAXIMO) return null;
    if (fps < 1 || fps > FPS_MAXIMO || bitrate < 1 || bitrate > BITRATE_MAXIMO) return null;
  }
  return linha;
}

/** O token que o portal devolve, persistido em `userData` entre transmissões. */
export function lerTokenDoPortal(texto: string | null): string | null {
  if (texto === null) return null;
  try {
    const dados: unknown = JSON.parse(texto);
    if (typeof dados !== 'object' || dados === null) return null;
    const token = (dados as Record<string, unknown>)['restaurar'];
    return typeof token === 'string' && token.length > 0 && token.length <= 512 ? token : null;
  } catch {
    return null;
  }
}

export function serializarTokenDoPortal(token: string): string {
  return JSON.stringify({ restaurar: token });
}

/** Códigos do evento `erro` do processo que explicam um fim — o resto é `MORREU`. */
function motivoDoFim(codigo: string | null): MotivoDoFim {
  if (codigo === 'FONTE_ENCERRADA' || codigo === 'PIPELINE' || codigo === 'PORTAL') return codigo;
  return 'MORREU';
}

function erroDeInicio(codigo: string | null): ErroDaCapturaNativa {
  switch (codigo) {
    case 'CANCELADO':
    case 'SEM_NVENC':
    case 'SEM_COMPONENTE':
    case 'PORTAL':
    case 'PIPELINE':
      return codigo;
    default:
      return 'MORREU';
  }
}

type Estado = 'iniciando' | 'capturando' | 'encerrando' | 'encerrado';

type Sessao = {
  readonly id: number;
  readonly processo: ProcessoFilho;
  readonly saidas: SaidasDaSessao;
  estado: Estado;
  ultimoErro: string | null;
  resolver: ((r: Result<ProntoDaCaptura, ErroDaCapturaNativa>) => void) | null;
  cancelarTimers: Array<() => void>;
};

/** Depois de `parar`, quanto esperar o processo sair sozinho antes dos sinais. */
const SIGTERM_APOS_MS = 1500;
const SIGKILL_APOS_MS = 3000;

export class CapturaNativa {
  private proximoId = 1;
  private atual: Sessao | null = null;
  private iniciando: Sessao | null = null;

  constructor(private readonly deps: DepsDaCapturaNativa) {}

  /** A sessão capturando agora, se houver. */
  get idAtual(): number | null {
    return this.atual?.id ?? null;
  }

  iniciar(
    pedido: PedidoDeCapturaNativa,
    restaurar: string | null,
    saidas: SaidasDaSessao,
  ): Promise<Result<ProntoDaCaptura, ErroDaCapturaNativa>> {
    if (this.iniciando !== null) return Promise.resolve({ ok: false, error: 'OCUPADO' });
    let processo: ProcessoFilho;
    try {
      processo = this.deps.spawn(argumentosDoHelper(pedido, restaurar));
    } catch {
      return Promise.resolve({ ok: false, error: 'INDISPONIVEL' });
    }
    const sessao: Sessao = {
      id: this.proximoId++,
      processo,
      saidas,
      estado: 'iniciando',
      ultimoErro: null,
      resolver: null,
      cancelarTimers: [],
    };
    this.iniciando = sessao;
    const promessa = new Promise<Result<ProntoDaCaptura, ErroDaCapturaNativa>>((resolver) => {
      sessao.resolver = resolver;
    });

    const leitor = new LeitorDoProtocolo({
      quadro: (q) => {
        if (sessao.estado === 'capturando') saidas.quadro(q);
      },
      captura: () => {
        if (sessao.estado === 'capturando') saidas.captura();
      },
      evento: (e) => this.aoEvento(sessao, e),
      corrompido: () => {
        // Sem como confiar no que vem depois: encerra, e a política de queda segue.
        sessao.ultimoErro = 'PIPELINE';
        processo.kill('SIGKILL');
      },
    });
    processo.stdout.on('data', (pedaco) => leitor.receber(pedaco));
    processo.on('exit', (codigo) => this.aoSair(sessao, codigo));
    // ENOENT e afins chegam aqui, não como exceção do `spawn`.
    processo.on('error', () => {
      if (sessao.estado === 'iniciando') sessao.ultimoErro = 'INDISPONIVEL';
      this.aoSair(sessao, null);
    });
    return promessa;
  }

  /** Uma linha do protocolo de ordens, já validada por `ordemValida`. */
  ordem(id: number, linha: string): void {
    const sessao = this.sessao(id);
    if (sessao === null) return;
    if (linha === 'parar') {
      this.parar(id);
      return;
    }
    if (sessao.estado === 'iniciando' || sessao.estado === 'capturando') sessao.processo.stdin.write(`${linha}\n`);
  }

  /** Encerra em silêncio: `encerrou` não é chamado para quem pediu para parar. */
  parar(id: number): void {
    const sessao = this.sessao(id);
    if (sessao !== null) this.encerrar(sessao);
  }

  pararTudo(): void {
    if (this.iniciando !== null) this.encerrar(this.iniciando);
    if (this.atual !== null) this.encerrar(this.atual);
  }

  private sessao(id: number): Sessao | null {
    if (this.atual?.id === id) return this.atual;
    if (this.iniciando?.id === id) return this.iniciando;
    return null;
  }

  private encerrar(sessao: Sessao): void {
    if (sessao.estado === 'encerrando' || sessao.estado === 'encerrado') return;
    const eraIniciando = sessao.estado === 'iniciando';
    sessao.estado = 'encerrando';
    // Quem está encerrando já não é "a captura atual": ordem nenhuma a alcança.
    if (this.atual === sessao) this.atual = null;
    try {
      sessao.processo.stdin.write('parar\n');
      sessao.processo.stdin.end();
    } catch {
      // O cano já pode ter fechado; os sinais abaixo cobrem.
    }
    sessao.cancelarTimers.push(
      this.deps.agendar(() => sessao.processo.kill('SIGTERM'), SIGTERM_APOS_MS),
      this.deps.agendar(() => sessao.processo.kill('SIGKILL'), SIGKILL_APOS_MS),
    );
    if (eraIniciando) this.resolver(sessao, { ok: false, error: 'CANCELADO' });
  }

  private resolver(sessao: Sessao, r: Result<ProntoDaCaptura, ErroDaCapturaNativa>): void {
    if (this.iniciando === sessao) this.iniciando = null;
    const resolver = sessao.resolver;
    sessao.resolver = null;
    resolver?.(r);
  }

  private aoEvento(sessao: Sessao, e: EventoDoNativo): void {
    if (sessao.estado === 'encerrado') return;
    const nome = e['evento'];
    if (nome === 'erro' && typeof e['codigo'] === 'string') sessao.ultimoErro = e['codigo'];
    if (nome === 'pronto' && sessao.estado === 'iniciando') {
      const fonte = e['fonte'];
      const f = typeof fonte === 'object' && fonte !== null ? (fonte as Record<string, unknown>) : {};
      const width = typeof f['width'] === 'number' ? f['width'] : 0;
      const height = typeof f['height'] === 'number' ? f['height'] : 0;
      const restaurar = typeof e['restaurar'] === 'string' ? e['restaurar'] : null;
      const memoria = typeof e['memoria'] === 'string' ? e['memoria'] : 'desconhecida';
      sessao.estado = 'capturando';
      // A anterior só sai depois de a nova estar entregando: sem buraco.
      const anterior = this.atual;
      this.atual = sessao;
      if (anterior !== null) this.encerrar(anterior);
      // O evento vai à porta antes do `ok`: o codificador recebe o tamanho e
      // só então o transporte o inicia.
      sessao.saidas.evento(e);
      this.resolver(sessao, { ok: true, value: { id: sessao.id, fonte: { width, height }, memoria, restaurar } });
      return;
    }
    if (sessao.estado === 'iniciando' || sessao.estado === 'capturando') sessao.saidas.evento(e);
  }

  private aoSair(sessao: Sessao, codigo: number | null): void {
    if (sessao.estado === 'encerrado') return;
    const estado = sessao.estado;
    sessao.estado = 'encerrado';
    for (const cancelar of sessao.cancelarTimers) cancelar();
    sessao.cancelarTimers = [];
    if (this.atual === sessao) this.atual = null;
    if (estado === 'iniciando') {
      this.resolver(
        sessao,
        sessao.ultimoErro === 'INDISPONIVEL' ? { ok: false, error: 'INDISPONIVEL' } : { ok: false, error: erroDeInicio(sessao.ultimoErro) },
      );
      return;
    }
    if (estado === 'capturando') {
      sessao.saidas.encerrou({ id: sessao.id, motivo: motivoDoFim(sessao.ultimoErro), codigo });
    }
    // `encerrando`: quem pediu para parar já sabe.
  }
}

export type ResultadoDaSonda = {
  readonly nvenc: boolean;
  /** Para o diagnóstico: versão do GStreamer, ou o código do que faltou. */
  readonly detalhe: string;
};

/** Sem resposta neste prazo a GPU ou o driver estão travados: o app não espera. */
const PRAZO_DA_SONDA_MS = 8000;

/**
 * `tela-captura --sondar`, uma vez ao abrir o app: NVENC usável ou não. Não
 * captura, não abre diálogo. Qualquer problema é "não" — o Chromium codifica,
 * e o diagnóstico mostra o motivo.
 */
export function sondarNvenc(deps: DepsDaCapturaNativa, prazoMs = PRAZO_DA_SONDA_MS): Promise<ResultadoDaSonda> {
  return new Promise((resolver) => {
    let processo: ProcessoFilho;
    try {
      processo = deps.spawn(['--sondar']);
    } catch {
      resolver({ nvenc: false, detalhe: 'INDISPONIVEL' });
      return;
    }
    let detalhe = 'MORREU';
    let sondaOk = false;
    let terminou = false;
    const terminar = (r: ResultadoDaSonda): void => {
      if (terminou) return;
      terminou = true;
      cancelarPrazo();
      resolver(r);
    };
    const leitor = new LeitorDoProtocolo({
      quadro: () => undefined,
      evento: (e) => {
        if (e['evento'] === 'sonda' && e['nvenc'] === true) {
          sondaOk = true;
          detalhe = typeof e['gstreamer'] === 'string' ? e['gstreamer'] : 'GStreamer';
        } else if (e['evento'] === 'erro' && typeof e['codigo'] === 'string') {
          detalhe = e['codigo'];
        }
      },
      corrompido: () => {
        detalhe = 'PROTOCOLO';
        processo.kill('SIGKILL');
      },
    });
    processo.stdout.on('data', (pedaco) => leitor.receber(pedaco));
    processo.on('exit', (codigo) => terminar({ nvenc: codigo === 0 && sondaOk, detalhe }));
    processo.on('error', () => terminar({ nvenc: false, detalhe: 'INDISPONIVEL' }));
    const cancelarPrazo = deps.agendar(() => {
      processo.kill('SIGKILL');
      terminar({ nvenc: false, detalhe: 'PRAZO' });
    }, prazoMs);
  });
}
