import type { Random } from '../core/ports/random.js';

export function makeCryptoRandom(): Random {
  return {
    bytes(length) {
      const buffer = new Uint8Array(length);
      crypto.getRandomValues(buffer);
      return buffer;
    },
  };
}
