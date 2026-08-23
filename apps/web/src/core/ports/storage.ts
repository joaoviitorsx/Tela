/** localStorage atrás de uma porta: `core/` não conhece `window`. */
export type Storage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};
