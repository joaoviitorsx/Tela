/** Fonte de aleatoriedade criptográfica, injetada para o teste ser determinístico. */
export type Random = { bytes(length: number): Uint8Array };
