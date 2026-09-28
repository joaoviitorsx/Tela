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
export const INVITE_KEY = 'tela.convite';

const TOKEN_BYTES = 32;
/** 128 bits: o mínimo do §9.1 para um segredo que vai num link compartilhado. */
const INVITE_BYTES = 16;
const INVITE_RE = /^[A-Za-z0-9_-]{22,128}$/;

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
  /**
   * O segredo do link de quem assiste (TELA-018). Independente do token do
   * dono: vai no link, e o token nunca. Fixo entre transmissões — o link
   * continua "permanente" — até o dono renovar.
   */
  convite(): string;
  /** Gera outro convite e o guarda. O link velho deixa de abrir a sala. */
  renovarConvite(): string;
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
    convite() {
      const existente = storage.get(INVITE_KEY);
      if (existente !== null && INVITE_RE.test(existente)) return existente;
      return this.renovarConvite();
    },
    renovarConvite() {
      const novo = toBase64Url(random.bytes(INVITE_BYTES));
      storage.set(INVITE_KEY, novo);
      return novo;
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
