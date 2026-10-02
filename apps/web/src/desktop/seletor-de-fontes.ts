import type { FonteDeCaptura } from './ponte.js';

/**
 * O estado do seletor próprio de fontes (PLANO-desktop §11): o que a
 * interface desenha e o que o adapter de captura espera.
 *
 * É uma loja sem React: `assinar`/`snapshot` são o par que o
 * `useSyncExternalStore` consome, e `abrir()` devolve uma promessa que o
 * adapter de captura (`captura-desktop.ts`) espera — quem transmite não sabe
 * que existe interface no meio, só vê um `ScreenCapture.request` demorado.
 *
 * As miniaturas custam uma captura de cada janela; por isso a listagem só
 * roda com o seletor aberto, a cada `intervaloMs`, e some ao fechar.
 */
export type AbaDoSeletor = 'janelas' | 'telas';

export type EstadoDoSeletor = {
  readonly aberto: boolean;
  readonly aba: AbaDoSeletor;
  readonly fontes: readonly FonteDeCaptura[];
  /** Ainda sem a primeira listagem desta abertura. */
  readonly carregando: boolean;
};

export type SeletorDeFontes = {
  snapshot(): EstadoDoSeletor;
  assinar(ouvinte: () => void): () => void;
  /** Abre e espera: a fonte escolhida, ou `null` se a pessoa cancelou. */
  abrir(): Promise<FonteDeCaptura | null>;
  mudarAba(aba: AbaDoSeletor): void;
  escolher(id: string): void;
  cancelar(): void;
};

export type DepsDoSeletor = {
  readonly listar: () => Promise<readonly FonteDeCaptura[]>;
  readonly agendar: (fn: () => void, ms: number) => () => void;
  /** Entre uma listagem e a próxima, com o seletor aberto. */
  readonly intervaloMs?: number;
};

const FECHADO: EstadoDoSeletor = { aberto: false, aba: 'telas', fontes: [], carregando: false };

/** Duas por segundo seria custo; uma a cada dois segundos acompanha janelas abrindo. */
const INTERVALO_PADRAO_MS = 2000;

export function makeSeletorDeFontes(deps: DepsDoSeletor): SeletorDeFontes {
  const intervalo = deps.intervaloMs ?? INTERVALO_PADRAO_MS;
  let estado: EstadoDoSeletor = FECHADO;
  const ouvintes = new Set<() => void>();
  let resolver: ((fonte: FonteDeCaptura | null) => void) | null = null;
  let cancelarProxima: (() => void) | null = null;
  /** Cada abertura é uma geração: uma listagem atrasada da anterior não entra. */
  let geracao = 0;

  const definir = (proximo: EstadoDoSeletor): void => {
    estado = proximo;
    for (const o of ouvintes) o();
  };

  const atualizar = async (g: number): Promise<void> => {
    let fontes: readonly FonteDeCaptura[];
    try {
      fontes = await deps.listar();
    } catch {
      fontes = estado.fontes; // a listagem falhar não fecha o seletor: a anterior fica
    }
    if (g !== geracao || !estado.aberto) return;
    definir({ ...estado, fontes, carregando: false });
    cancelarProxima = deps.agendar(() => void atualizar(g), intervalo);
  };

  const fechar = (fonte: FonteDeCaptura | null): void => {
    geracao += 1;
    cancelarProxima?.();
    cancelarProxima = null;
    const r = resolver;
    resolver = null;
    // Fechado não guarda fontes: as miniaturas são o que pesa.
    definir({ ...FECHADO, aba: estado.aba });
    r?.(fonte);
  };

  return {
    snapshot: () => estado,
    assinar: (ouvinte) => {
      ouvintes.add(ouvinte);
      return () => {
        ouvintes.delete(ouvinte);
      };
    },
    abrir: () => {
      // Abrir por cima de outro pedido é desistir do primeiro.
      if (resolver !== null) fechar(null);
      geracao += 1;
      const g = geracao;
      const promessa = new Promise<FonteDeCaptura | null>((r) => {
        resolver = r;
      });
      definir({ aberto: true, aba: estado.aba, fontes: [], carregando: true });
      void atualizar(g);
      return promessa;
    },
    mudarAba: (aba) => {
      if (aba !== estado.aba) definir({ ...estado, aba });
    },
    escolher: (id) => {
      if (!estado.aberto) return;
      const fonte = estado.fontes.find((f) => f.id === id);
      // Só o que está na tela pode ser escolhido: o main confere a mesma lista.
      if (fonte !== undefined) fechar(fonte);
    },
    cancelar: () => {
      if (estado.aberto) fechar(null);
    },
  };
}
