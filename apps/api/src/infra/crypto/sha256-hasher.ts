import { createHash, timingSafeEqual } from 'node:crypto';
import type { Hasher } from '../../ports/hasher.js';

export function makeSha256Hasher(): Hasher {
  return {
    hash(input: string): string {
      return createHash('sha256').update(input, 'utf8').digest('hex');
    },
    /**
     * Comparação em tempo constante. `a === b` vaza, pelo tempo de resposta,
     * quantos caracteres iniciais do hash o atacante acertou.
     */
    equals(a: string, b: string): boolean {
      if (a.length !== b.length) return false;
      const bufA = Buffer.from(a, 'utf8');
      const bufB = Buffer.from(b, 'utf8');
      if (bufA.length !== bufB.length) return false;
      return timingSafeEqual(bufA, bufB);
    },
  };
}
