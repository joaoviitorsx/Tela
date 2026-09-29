import type { Random } from '../ports/random.js';
import type { Storage } from '../ports/storage.js';

/**
 * A credencial do usuário. Não há senha, não há e-mail, não há recuperação
 * pelo servidor — 32 bytes aleatórios no localStorage SÃO a conta.
 *
 * Trade-off consciente e comunicado na UI: perdeu o localStorage, perdeu o
 * slug. Em troca, o produto inteiro não trata nenhum dado pessoal (§15).
 */
export const OWNER_KEY = 'tela.owner';
export const SLUG_KEY = 'tela.slug';
/**
 * Onde o convite do link morava (TELA-018) até a ADR 0026 tirá-lo. Só para
 * `forget()` limpar o que ficou em navegadores que já transmitiram.
 */
export const INVITE_KEY = 'tela.convite';

const TOKEN_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type Identity = {
  /** Cria na primeira vez, reaproveita depois. Nunca rotaciona sozinho. */
  ownerToken(): string;
  savedSlug(): string | null;
  rememberSlug(slug: string): void;
  /** Para a tela de recuperação: o usuário exporta e guarda onde quiser. */
  exportToken(): string;
  importToken(token: string): void;
  forget(): void;
};

export function makeIdentity(storage: Storage, random: Random): Identity {
  return {
    ownerToken() {
      const existing = storage.get(OWNER_KEY);
      if (existing !== null && existing.length >= 43) return existing;
      const created = toBase64Url(random.bytes(TOKEN_BYTES));
      storage.set(OWNER_KEY, created);
      return created;
    },
    savedSlug: () => storage.get(SLUG_KEY),
    rememberSlug: (slug) => storage.set(SLUG_KEY, slug),
    exportToken() {
      return this.ownerToken();
    },
    importToken(token) {
      storage.set(OWNER_KEY, token.trim());
    },
    forget() {
      storage.remove(OWNER_KEY);
      storage.remove(SLUG_KEY);
      storage.remove(INVITE_KEY);
    },
  };
}
