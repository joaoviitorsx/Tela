export type Hasher = {
  /** sha256 hex do ownerToken. O token cru nunca é persistido. */
  hash(input: string): string;
  /** Comparação em tempo constante. Nunca use `===` para isto. */
  equals(a: string, b: string): boolean;
};
