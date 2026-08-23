/** Identidades anônimas e descartáveis de espectador. */
export type IdGenerator = { next(prefix: string): string };
