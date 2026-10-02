import { chmodSync, writeFileSync } from 'node:fs';

/**
 * Grava um arquivo de `userData` só para o dono (S-22): `captura-portal.json`
 * (token do portal) e `ajustes.json`. O `mode` do `writeFileSync` só vale na
 * CRIAÇÃO — um arquivo de uma versão anterior, criado com a umask padrão
 * (0644), continuaria legível por outros usuários; o `chmod` corrige. No
 * Windows `mode` é quase ignorado e o `chmod` só mexe no bit de leitura:
 * inofensivo.
 */
export const MODO_PRIVADO = 0o600;

export function gravarArquivoPrivado(caminho: string, conteudo: string): void {
  writeFileSync(caminho, conteudo, { encoding: 'utf8', mode: MODO_PRIVADO });
  try {
    chmodSync(caminho, MODO_PRIVADO);
  } catch {
    // Já gravou; um sistema de arquivos sem permissões (FAT, rede) não é falha.
  }
}
