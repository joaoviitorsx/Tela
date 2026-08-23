import { randomBytes } from 'node:crypto';
import type { IdGenerator } from '../../ports/id-generator.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Identidade curta, aleatória e descartável. Não é sequencial de propósito:
 * `v_1`, `v_2` revelaria quantas pessoas assistiram desde o restart.
 */
export function makeRandomIdGenerator(size = 8): IdGenerator {
  return {
    next(prefix: string): string {
      const bytes = randomBytes(size);
      let out = '';
      for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
      return `${prefix}_${out}`;
    },
  };
}
