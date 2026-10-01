/// <reference types="vite/client" />

/**
 * As variáveis de build do front. Sem isto `import.meta.env['VITE_…']` é
 * `any`, e um nome digitado errado vira `undefined` em produção sem aviso.
 */
interface ImportMetaEnv {
  /** Endereço do signaling (`wss://…/signal`). Em dev, o proxy do Vite supre. */
  readonly VITE_SIGNAL_URL?: string;
  /**
   * Origem pública do site (`https://tela.gg`), para o link compartilhado
   * pelo app desktop — que roda em `app://tela` e não pode mandar isso a
   * ninguém (PLANO-desktop §3.5). A web não precisa: usa a própria origem.
   */
  readonly VITE_PUBLIC_ORIGIN?: string;
}
