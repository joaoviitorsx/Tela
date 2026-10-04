import { createPublicKey, verify as verifyNativo } from 'node:crypto';

/**
 * Verificação de assinatura do instalador do update (ADR 0038, U-1).
 *
 * O electron-updater confere o SHA-512 do instalador contra o `latest.yml` —
 * mas os dois vêm do MESMO release, então quem compromete o canal de publicação
 * troca o instalador E o hash juntos. A trava é uma assinatura Ed25519 do
 * instalador, feita com uma chave privada que vive OFFLINE (nunca no CI), cuja
 * pública está embutida aqui. Instalador não assinado, ou assinatura que não
 * bate com esta chave, NÃO é instalado.
 *
 * Assina-se o arquivo do instalador em si (o `.exe` e o `.AppImage` — os únicos
 * que auto-atualizam; deb/rpm só avisam), não o `latest.yml`: Ed25519 puro sobre
 * os bytes do arquivo dispensa parser de YAML e recomputar hash, e amarra os
 * bytes que vão rodar diretamente à chave do dono.
 */

/**
 * Chave PÚBLICA do update do Tela (Ed25519, SPKI PEM). A privada correspondente
 * é do dono e vive offline — ver `docs/adr/0038`. Trocar isto só com uma chave
 * nova gerada pelo dono.
 */
export const CHAVE_PUBLICA_DO_UPDATE =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MCowBQYDK2VwAyEA5DTYBhZYyTuY1k10/lFaN+OhQb6s5s3Q7gVmNuNduRo=\n' +
  '-----END PUBLIC KEY-----\n';

/** `verify(null, …)` do Node, injetável para teste. Ed25519 não leva algoritmo. */
export type VerificadorEd25519 = (
  algoritmo: null,
  dados: Uint8Array,
  chave: ReturnType<typeof createPublicKey>,
  assinatura: Uint8Array,
) => boolean;

/**
 * `true` só quando a assinatura é da chave do Tela sobre exatamente estes bytes.
 * Qualquer erro (chave inválida, assinatura malformada, bytes vazios) é `false`:
 * fail-closed, porque isto decide se um binário vai rodar na máquina da pessoa.
 */
export function assinaturaConfere(
  conteudo: Uint8Array,
  assinatura: Uint8Array,
  chavePem: string = CHAVE_PUBLICA_DO_UPDATE,
  verify: VerificadorEd25519 = verifyNativo as VerificadorEd25519,
): boolean {
  if (conteudo.length === 0 || assinatura.length === 0) return false;
  try {
    const chave = createPublicKey(chavePem);
    return verify(null, conteudo, chave, assinatura) === true;
  } catch {
    return false;
  }
}

/** A URL da assinatura destacada de um instalador no release (`<arquivo>.sig`). */
export function urlDaAssinatura(urlDoInstalador: string): string {
  return `${urlDoInstalador}.sig`;
}
