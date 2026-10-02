import type { AppComSom, CapacidadesDeSom, PlataformaDesktop } from './ponte.js';

/**
 * A escolha de som do app (D3, PLANO-desktop §4) e o que dela se SABE.
 *
 * Três opções, nas duas plataformas, com o modo REAL sempre à vista — nunca
 * "áudio ativo" só porque existe uma trilha:
 *
 * - **sistema**: tudo que toca, inclusive a call (Windows: `loopback` do
 *   Electron junto da tela; Linux: o monitor da saída padrão);
 * - **jogo**: só o app escolhido (Windows: addon WASAPI; Linux: sink do Tela);
 * - **nenhum**: sem trilha de áudio, por escolha.
 *
 * Loja sem React (`assinar`/`snapshot`, para `useSyncExternalStore`), como a
 * do seletor de fontes. O adapter de áudio (`audio-desktop.ts`) lê a escolha
 * daqui no momento de capturar e registra o que DEU CERTO — o rótulo "real"
 * muda de plano para fato.
 */
export type EscolhaDeSom =
  | { readonly tipo: 'sistema' }
  | { readonly tipo: 'jogo'; readonly appId: string | null; readonly nome: string | null }
  | { readonly tipo: 'nenhum' };

/** O que a última captura entregou, para a escolha de então. */
export type ResultadoDoSom =
  | { readonly situacao: 'ativo' }
  | { readonly situacao: 'falhou'; readonly motivo: string }
  | { readonly situacao: 'parou'; readonly motivo: string };

export type RealDoSom = {
  /** `SÓ O JOGO · Minecraft`. */
  readonly rotulo: string;
  /** Uma palavra para o medidor. */
  readonly curto: string;
  /** `alerta` quando o que vai ao ar NÃO é o que a pessoa escolheu. */
  readonly tom: 'ok' | 'alerta';
};

export type EstadoDoSom = {
  readonly escolha: EscolhaDeSom;
  /** `null` até o main responder. */
  readonly capacidades: CapacidadesDeSom | null;
  readonly apps: readonly AppComSom[];
  /** Ainda sem a primeira listagem. */
  readonly listando: boolean;
  readonly resultado: ResultadoDoSom | null;
  readonly real: RealDoSom;
  readonly pendente: string | null;
  readonly plataforma: PlataformaDesktop;
};

export type SomDesktop = {
  snapshot(): EstadoDoSom;
  assinar(ouvinte: () => void): () => void;
  /** Quem desenha o seletor chama ao montar; devolve o cancelamento. Só com observador a loja pergunta ao main. */
  observar(): () => void;
  escolherSistema(): void;
  escolherNenhum(): void;
  /** Passa a "só o jogo" (sem app ainda) — ou mantém, se já está. */
  escolherJogo(): void;
  escolherApp(app: AppComSom): void;
  atualizarApps(): void;
  /** O adapter de áudio conta o que aconteceu com a captura. */
  registrar(resultado: ResultadoDoSom): void;
  escolhaAtual(): EscolhaDeSom;
};

export type DepsDoSom = {
  readonly plataforma: PlataformaDesktop;
  readonly capacidades: () => Promise<CapacidadesDeSom>;
  readonly listarApps: () => Promise<readonly AppComSom[]>;
  readonly agendar: (fn: () => void, ms: number) => () => void;
  /** Entre listagens, com "só o jogo" escolhido e o seletor montado. */
  readonly intervaloMs?: number;
  /** Onde a última escolha fica guardada entre uma transmissão e outra. */
  readonly memoria?: {
    readonly ler: () => string | null;
    readonly gravar: (valor: string) => void;
  };
};

/**
 * Sem escolha guardada, o padrão é SEM SOM — não "sistema". "Sistema" inclui a
 * call do Discord, e quem assiste costuma estar NA MESMA call: ouviria a
 * própria voz de volta, com atraso. Quem quer som escolhe uma vez e o app
 * lembra. Do jogo guarda-se o NOME: o id do processo muda a cada sessão.
 */
export function escolhaGuardada(valor: string | null): EscolhaDeSom {
  if (valor === 'sistema') return { tipo: 'sistema' };
  if (valor !== null && valor.startsWith('jogo:')) {
    const nome = valor.slice('jogo:'.length);
    return { tipo: 'jogo', appId: null, nome: nome === '' ? null : nome };
  }
  return { tipo: 'nenhum' };
}

export function serializarEscolha(escolha: EscolhaDeSom): string {
  if (escolha.tipo === 'jogo') return `jogo:${escolha.nome ?? ''}`;
  return escolha.tipo;
}

const INTERVALO_PADRAO_MS = 3000;

const SEM_CAPACIDADES_AINDA: CapacidadesDeSom | null = null;

/**
 * O rótulo do modo REAL — puro. `capacidades` e `apps` entram porque o plano
 * muda quando o jogo escolhido fechou ou o componente não existe; `resultado`,
 * quando a captura já aconteceu.
 */
export function descreverReal(
  escolha: EscolhaDeSom,
  plataforma: PlataformaDesktop,
  capacidades: CapacidadesDeSom | null,
  apps: readonly AppComSom[],
  resultado: ResultadoDoSom | null,
): RealDoSom {
  if (escolha.tipo === 'nenhum') return { rotulo: 'SEM SOM', curto: 'SEM SOM', tom: 'ok' };

  if (resultado?.situacao === 'falhou' || resultado?.situacao === 'parou') {
    return { rotulo: `SEM SOM · ${resultado.motivo}`, curto: 'SEM SOM', tom: 'alerta' };
  }

  if (escolha.tipo === 'sistema') {
    const onde = plataforma === 'linux' ? 'saída padrão · inclui a call' : 'inclui a call';
    return { rotulo: `SISTEMA · ${onde}`, curto: 'SISTEMA', tom: 'ok' };
  }

  if (capacidades !== null && !capacidades.jogo.disponivel) {
    return { rotulo: 'SÓ O JOGO · indisponível', curto: 'SEM SOM', tom: 'alerta' };
  }
  if (escolha.appId === null || escolha.nome === null) {
    return { rotulo: 'SÓ O JOGO · escolha o jogo', curto: 'SÓ O JOGO', tom: 'alerta' };
  }
  // O jogo escolhido fechou antes de ir ao ar: dizer, em vez de prometer o som dele.
  const noAr = apps.find((a) => a.id === escolha.appId);
  if (apps.length > 0 && noAr === undefined) {
    return { rotulo: `SÓ O JOGO · ${escolha.nome} (não está aberto)`, curto: 'SÓ O JOGO', tom: 'alerta' };
  }
  return { rotulo: `SÓ O JOGO · ${escolha.nome}`, curto: 'SÓ O JOGO', tom: 'ok' };
}

/** O motivo de ainda não dar para ir ao ar, ou `null`. Só uma escolha incompleta bloqueia. */
export function pendenteDoSom(escolha: EscolhaDeSom, capacidades: CapacidadesDeSom | null): string | null {
  if (escolha.tipo !== 'jogo') return null;
  if (capacidades !== null && !capacidades.jogo.disponivel) return 'Só o jogo não está disponível. Escolha outra opção de som.';
  return escolha.appId === null ? 'Escolha o jogo na lista de apps com som.' : null;
}

export function makeSomDesktop(deps: DepsDoSom): SomDesktop {
  const intervalo = deps.intervaloMs ?? INTERVALO_PADRAO_MS;
  const ouvintes = new Set<() => void>();
  let observadores = 0;
  let escolha: EscolhaDeSom = escolhaGuardada(deps.memoria?.ler() ?? null);
  let capacidades: CapacidadesDeSom | null = SEM_CAPACIDADES_AINDA;
  let apps: readonly AppComSom[] = [];
  let listando = false;
  let resultado: ResultadoDoSom | null = null;
  let cancelarProxima: (() => void) | null = null;
  let capacidadesPedidas = false;
  /** Uma listagem atrasada de uma observação anterior não entra. */
  let geracao = 0;

  const montar = (): EstadoDoSom => ({
    escolha,
    capacidades,
    apps,
    listando,
    resultado,
    real: descreverReal(escolha, deps.plataforma, capacidades, apps, resultado),
    pendente: pendenteDoSom(escolha, capacidades),
    plataforma: deps.plataforma,
  });
  let estado = montar();
  const publicar = (): void => {
    estado = montar();
    for (const o of ouvintes) o();
  };

  const querListar = (): boolean => observadores > 0 && escolha.tipo === 'jogo' && capacidades?.jogo.disponivel === true;

  const listar = async (g: number): Promise<void> => {
    listando = apps.length === 0;
    if (listando) publicar();
    let achados: readonly AppComSom[];
    try {
      achados = await deps.listarApps();
    } catch {
      achados = apps; // listar falhar não esvazia a lista: a anterior fica
    }
    if (g !== geracao) return;
    listando = false;
    apps = achados;
    // Jogo lembrado pelo nome: se ele está aberto, já vem escolhido.
    if (escolha.tipo === 'jogo' && escolha.appId === null && escolha.nome !== null) {
      const nome = escolha.nome;
      const aberto = achados.find((a) => a.nome === nome);
      if (aberto !== undefined) escolha = { tipo: 'jogo', appId: aberto.id, nome: aberto.nome };
    }
    publicar();
    cancelarProxima = querListar() ? deps.agendar(() => void listar(g), intervalo) : null;
  };

  /** Recomeça (ou para) a varredura conforme o que está à vista. */
  const reavaliar = (): void => {
    cancelarProxima?.();
    cancelarProxima = null;
    geracao += 1;
    if (querListar()) void listar(geracao);
  };

  const carregarCapacidades = (): void => {
    if (capacidadesPedidas) return;
    capacidadesPedidas = true;
    void deps.capacidades().then(
      (c) => {
        capacidades = c;
        publicar();
        reavaliar();
      },
      () => {
        capacidades = { jogo: { disponivel: false, motivo: 'Não foi possível consultar o sistema de áudio.' } };
        publicar();
      },
    );
  };

  const mudar = (nova: EscolhaDeSom): void => {
    escolha = nova;
    deps.memoria?.gravar(serializarEscolha(nova));
    // O que aconteceu na captura anterior era para a escolha anterior.
    resultado = null;
    publicar();
    reavaliar();
  };

  return {
    snapshot: () => estado,
    assinar: (o) => {
      ouvintes.add(o);
      return () => {
        ouvintes.delete(o);
      };
    },
    observar: () => {
      observadores += 1;
      carregarCapacidades();
      reavaliar();
      return () => {
        observadores = Math.max(0, observadores - 1);
        if (observadores === 0) reavaliar();
      };
    },
    escolherSistema: () => mudar({ tipo: 'sistema' }),
    escolherNenhum: () => mudar({ tipo: 'nenhum' }),
    escolherJogo: () => {
      if (escolha.tipo !== 'jogo') mudar({ tipo: 'jogo', appId: null, nome: null });
    },
    escolherApp: (app) => mudar({ tipo: 'jogo', appId: app.id, nome: app.nome }),
    atualizarApps: () => {
      if (querListar()) reavaliar();
    },
    registrar: (r) => {
      resultado = r;
      publicar();
    },
    escolhaAtual: () => escolha,
  };
}
