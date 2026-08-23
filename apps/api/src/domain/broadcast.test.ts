import { describe, expect, it } from 'vitest';
import { isAtViewerLimit, roomCapacity, toEpochSeconds } from './broadcast.js';

describe('regras de sala', () => {
  it('capacidade reserva a vaga do transmissor', () => {
    expect(roomCapacity(12)).toBe(13);
  });

  it('limite de espectadores conta só espectadores', () => {
    expect(isAtViewerLimit(11, 12)).toBe(false);
    expect(isAtViewerLimit(12, 12)).toBe(true);
    expect(isAtViewerLimit(13, 12)).toBe(true);
  });

  it('converte ms para segundos truncando', () => {
    expect(toEpochSeconds(1_755_900_000_999)).toBe(1_755_900_000);
  });
});
