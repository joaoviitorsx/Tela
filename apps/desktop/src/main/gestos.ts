/**
 * Gesto real do usuário como condição de capturar (S-05), puro.
 *
 * A única barreira de consentimento da captura é o seletor DENTRO da página, e
 * a página é código web: um renderer comprometido chamaria `capturaNativa.iniciar`
 * (no Linux o portal reaproveita o token e nem pergunta) ou `escolherFonte` em
 * silêncio. O main então só atende se houve entrada REAL há pouco — mouse ou
 * teclado que o Chromium recebeu do sistema (`input-event` do `WebContents`).
 * JavaScript não fabrica isso: `dispatchEvent`/`.click()` não passam pelo
 * pipeline de entrada que o main escuta.
 */

/**
 * Quanto um gesto vale. Dez segundos: o clique em TRANSMITIR ainda passa pela
 * sondagem do nome e pela sinalização antes da captura, e o seletor próprio
 * leva o tempo de uma pessoa escolher — que clica na miniatura (outro gesto).
 */
export const VALIDADE_DO_GESTO_MS = 10_000;

/** Tipos de `InputEvent` do Electron que contam como "a pessoa fez algo". */
const TIPOS_DE_GESTO: ReadonlySet<string> = new Set([
  'mouseDown',
  'mouseUp',
  'keyDown',
  'rawKeyDown',
  'char',
  'touchStart',
  'touchEnd',
]);

/** Mover o mouse, rolar ou entrar na janela não é consentimento. */
export function ehGesto(tipo: string): boolean {
  return TIPOS_DE_GESTO.has(tipo);
}

export type PortaoDeGesto = {
  /** Registra um gesto do conteúdo `id` (já filtrado por `ehGesto`). */
  readonly registrar: (id: number) => void;
  /** Houve gesto no conteúdo `id` dentro da validade? */
  readonly recente: (id: number) => boolean;
  /** O conteúdo foi destruído: esquece. */
  readonly esquecer: (id: number) => void;
};

/**
 * `agora` é um relógio MONOTÔNICO em ms (`performance.now`): um ajuste de hora
 * do sistema não pode ressuscitar um gesto velho nem matar um novo.
 */
export function criarPortaoDeGesto(agora: () => number, validadeMs: number = VALIDADE_DO_GESTO_MS): PortaoDeGesto {
  const ultimos = new Map<number, number>();
  return {
    registrar: (id) => {
      ultimos.set(id, agora());
    },
    recente: (id) => {
      const ultimo = ultimos.get(id);
      if (ultimo === undefined) return false;
      const idade = agora() - ultimo;
      return idade >= 0 && idade <= validadeMs;
    },
    esquecer: (id) => {
      ultimos.delete(id);
    },
  };
}
