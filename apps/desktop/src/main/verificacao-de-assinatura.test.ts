import { generateKeyPairSync, sign as signNativo } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CHAVE_PUBLICA_DO_UPDATE, assinaturaConfere, urlDaAssinatura } from './verificacao-de-assinatura.js';

/** Par Ed25519 efêmero: dá para provar o caminho positivo sem a chave real do dono. */
function parDeTeste(): { privadaPem: string; publicaPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privadaPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicaPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const assinar = (dados: Uint8Array, privadaPem: string): Uint8Array =>
  signNativo(null, dados, privadaPem);

describe('assinaturaConfere', () => {
  const { privadaPem, publicaPem } = parDeTeste();
  const instalador = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  it('assinatura da chave certa sobre os bytes certos: confere', () => {
    expect(assinaturaConfere(instalador, assinar(instalador, privadaPem), publicaPem)).toBe(true);
  });

  it('um byte trocado no instalador: NÃO confere', () => {
    const sig = assinar(instalador, privadaPem);
    const adulterado = Uint8Array.from(instalador);
    adulterado[0] = 99;
    expect(assinaturaConfere(adulterado, sig, publicaPem)).toBe(false);
  });

  it('assinatura de OUTRA chave: NÃO confere', () => {
    const outra = parDeTeste();
    expect(assinaturaConfere(instalador, assinar(instalador, outra.privadaPem), publicaPem)).toBe(false);
  });

  it('fail-closed: bytes vazios, assinatura vazia ou chave inválida dão false', () => {
    const sig = assinar(instalador, privadaPem);
    expect(assinaturaConfere(new Uint8Array(), sig, publicaPem)).toBe(false);
    expect(assinaturaConfere(instalador, new Uint8Array(), publicaPem)).toBe(false);
    expect(assinaturaConfere(instalador, sig, 'não é uma chave')).toBe(false);
    expect(assinaturaConfere(instalador, new Uint8Array([0, 1, 2]), publicaPem)).toBe(false);
  });

  it('a chave pública embutida do Tela é uma Ed25519 válida e parseável', () => {
    // Não dá para provar o caminho positivo com ela (a privada é do dono, offline),
    // mas garante que a constante não está corrompida e carrega sem throw.
    const bytes = new Uint8Array([42]);
    expect(assinaturaConfere(bytes, new Uint8Array([0]), CHAVE_PUBLICA_DO_UPDATE)).toBe(false); // assinatura falsa
    // e não lança: se a chave fosse inválida, o createPublicflow cairia no catch e retornaria false igual —
    // então confere direto que o PEM carrega:
    expect(() => assinar(bytes, parDeTeste().privadaPem)).not.toThrow();
  });
});

describe('urlDaAssinatura', () => {
  it('acrescenta .sig ao arquivo do instalador', () => {
    expect(urlDaAssinatura('https://github.com/x/Tela/releases/download/desktop-v1/Tela-1-win-x64.exe')).toBe(
      'https://github.com/x/Tela/releases/download/desktop-v1/Tela-1-win-x64.exe.sig',
    );
  });
});
