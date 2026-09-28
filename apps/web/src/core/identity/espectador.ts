import { ApelidoSchema } from '@tela/shared';
import type { Random } from '../ports/random.js';
import type { Storage } from '../ports/storage.js';

/**
 * Quem assiste, do jeito mínimo que a aprovação manual precisa (ADR 0025).
 *
 * Não é conta (R6). A chave é um segredo deste navegador que o transmissor
 * nunca vê — ele recebe o sha256 dela, calculado pelo servidor — e serve só
 * para "já aceitei esta pessoa" valer na volta. O apelido é o que ele lê na
 * fila; ninguém confere, e duas pessoas podem usar o mesmo.
 */
export const CHAVE_ESPECTADOR_KEY = 'tela.espectador';
export const APELIDO_KEY = 'tela.apelido';

/** 128 bits, o mesmo piso do convite. */
const CHAVE_BYTES = 16;
const CHAVE_RE = /^[A-Za-z0-9_-]{22,128}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** O apelido como o servidor vai aceitar, ou `null` se não serve. */
export function apelidoValido(bruto: string): string | null {
  const r = ApelidoSchema.safeParse(bruto);
  return r.success ? r.data : null;
}

export type Espectador = {
  /** Cria na primeira vez; a mesma depois, para a aprovação valer na volta. */
  chave(): string;
  apelido(): string | null;
  /** Guarda só se for válido; devolve o que ficou guardado. */
  lembrarApelido(bruto: string): string | null;
};

export function makeEspectador(storage: Storage, random: Random): Espectador {
  return {
    chave() {
      const existente = storage.get(CHAVE_ESPECTADOR_KEY);
      if (existente !== null && CHAVE_RE.test(existente)) return existente;
      const nova = toBase64Url(random.bytes(CHAVE_BYTES));
      storage.set(CHAVE_ESPECTADOR_KEY, nova);
      return nova;
    },
    apelido() {
      const guardado = storage.get(APELIDO_KEY);
      return guardado === null ? null : apelidoValido(guardado);
    },
    lembrarApelido(bruto) {
      const valido = apelidoValido(bruto);
      if (valido !== null) storage.set(APELIDO_KEY, valido);
      return valido;
    },
  };
}
