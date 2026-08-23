/** Tempo é dependência. Caso de uso que chama Date.now() não é testável. */
export type Clock = { now(): number };
