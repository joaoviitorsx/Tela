import type { BroadcastSession, BroadcastState } from '../core/media/broadcast-session.js';

/**
 * Onde a moldura do app enxerga a transmissão (D4).
 *
 * A `BroadcastSession` pertence à rota `/transmitir` (nasce com ela, morre com
 * ela), e a moldura — o painel NO AR, o modo compacto, a bandeja — vive FORA
 * da rota. Para não duplicar estado nem mexer na rota, o container desktop
 * registra aqui cada sessão que cria (`container.desktop.ts`) e a
 * moldura só ASSINA. A fonte da verdade continua sendo a sessão: isto guarda
 * uma referência e repassa os avisos, como o `useSyncExternalStore` faria.
 *
 * Sem React e sem DOM (R1/R3): só a porta mínima da sessão.
 */
export type SessaoObservavel = Pick<BroadcastSession, 'getState' | 'subscribe' | 'stop' | 'pausar' | 'retomar'>;

export type InstantaneoDaSessao = {
  readonly state: BroadcastState;
  /** `Date.now()` de quando a sessão foi ao ar, ou `null` fora do ar. */
  readonly inicioMs: number | null;
};

const OCIOSO: InstantaneoDaSessao = { state: { status: 'idle' }, inicioMs: null };

const LIMITE_DE_REGISTROS = 4;

const encerrada = (s: BroadcastState): boolean => s.status === 'idle' || s.status === 'ended';

export type SessaoAoVivo = {
  /** Registra uma sessão recém-criada. Sessões mortas de antes são esquecidas. */
  readonly registrar: (sessao: SessaoObservavel) => void;
  readonly assinar: (ouvinte: () => void) => () => void;
  /** Referencialmente estável enquanto nada muda (serve ao `useSyncExternalStore`). */
  readonly instantaneo: () => InstantaneoDaSessao;
  /** Para a sessão que está no ar, sem perguntar. Resolve quando acabou de liberar tudo. */
  readonly parar: () => Promise<void>;
  /**
   * Oculta ou mostra a transmissão no ar (pausa de privacidade, TELA-022).
   * Resolve com o estado novo (`true` = oculta), ou `null` fora do ar.
   */
  readonly alternarOculto: () => Promise<boolean | null>;
};

export function criarSessaoAoVivo(agora: () => number = Date.now): SessaoAoVivo {
  type Registro = { readonly sessao: SessaoObservavel; readonly cancelar: () => void; inicioMs: number | null };
  let registros: Registro[] = [];
  const ouvintes = new Set<() => void>();
  let cache: InstantaneoDaSessao = OCIOSO;

  /**
   * A sessão que importa: a que está no ar (ou subindo); senão a mais recente.
   * O StrictMode do desenvolvimento cria duas por montagem, e só uma delas é a
   * da rota — a outra fica `idle` para sempre.
   */
  const escolhida = (): Registro | null =>
    registros.find((r) => !encerrada(r.sessao.getState())) ?? registros[registros.length - 1] ?? null;

  const recalcular = (): void => {
    for (const r of registros) {
      const vivo = r.sessao.getState().status === 'live';
      if (vivo && r.inicioMs === null) r.inicioMs = agora();
      if (!vivo) r.inicioMs = null;
    }
    const e = escolhida();
    const proximo: InstantaneoDaSessao = e === null ? OCIOSO : { state: e.sessao.getState(), inicioMs: e.inicioMs };
    if (proximo.state === cache.state && proximo.inicioMs === cache.inicioMs) return;
    cache = proximo;
    for (const o of [...ouvintes]) o();
  };

  return {
    registrar: (sessao) => {
      // Só as ENCERRADAS saem. Uma `idle` pode ser a da rota ainda sem `start()`:
      // com o StrictMode a rota fica com uma das duas, e não sabemos qual.
      for (const r of registros) if (r.sessao.getState().status === 'ended') r.cancelar();
      registros = registros.filter((r) => r.sessao.getState().status !== 'ended');
      registros.push({ sessao, cancelar: sessao.subscribe(recalcular), inicioMs: null });
      // Teto: ociosas esquecidas de visitas antigas não se acumulam.
      while (registros.length > LIMITE_DE_REGISTROS) {
        const i = registros.findIndex((r) => encerrada(r.sessao.getState()));
        if (i < 0) break;
        registros[i]?.cancelar();
        registros.splice(i, 1);
      }
      recalcular();
    },
    assinar: (ouvinte) => {
      ouvintes.add(ouvinte);
      return () => {
        ouvintes.delete(ouvinte);
      };
    },
    instantaneo: () => cache,
    parar: async () => {
      const r = escolhida();
      if (r === null || encerrada(r.sessao.getState())) return;
      await r.sessao.stop('USER_STOPPED');
    },
    alternarOculto: async () => {
      const r = escolhida();
      const s = r?.sessao.getState();
      if (r === null || s?.status !== 'live') return null;
      if (s.pausa === null) {
        // Pelo atalho, no meio do jogo: a imagem some e o som também — é o
        // gesto de "não quero mostrar isto agora". O botão do console deixa
        // escolher manter o som.
        await r.sessao.pausar({ manterSom: false });
        return true;
      }
      await r.sessao.retomar();
      return false;
    },
  };
}

/** A instância do app. Os testes criam a sua com `criarSessaoAoVivo`. */
export const sessaoAoVivo: SessaoAoVivo = criarSessaoAoVivo();
