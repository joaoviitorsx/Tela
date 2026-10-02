/**
 * Os `pw-loopback` que ESTE app subiu, para limpar os que sobraram de uma
 * execução que caiu sem limpar (S-12), puro.
 *
 * Antes, o pid a matar vinha de `application.process.id` do grafo do
 * PipeWire — uma propriedade que o próprio cliente DECLARA: um app em sandbox
 * com acesso ao socket se passava por `pw-loopback` e fazia o Tela mandar
 * SIGTERM ao processo que ele escolhesse. Agora o pid vem de um registro que só
 * o Tela escreve (pid de `spawn`, em `userData`) e, antes do sinal, o
 * `/proc/<pid>/cmdline` precisa conferir: um pid reciclado por outro programa
 * não bate.
 */
import { basename } from 'node:path';

export type FilhoRegistrado = { readonly pid: number; readonly nome: string };

/** O `-n` que `comandos-pw.ts` dá a cada `pw-loopback`: `tela_jogo_lb`, `tela_jogo_mic_lb`, `tela_sistema_mic_lb`. */
const NOME = /^tela_[a-z_]{1,40}$/;

export function lerRegistro(texto: string | null): readonly FilhoRegistrado[] {
  if (texto === null) return [];
  try {
    const dados: unknown = JSON.parse(texto);
    if (!Array.isArray(dados)) return [];
    const saida: FilhoRegistrado[] = [];
    for (const item of dados as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const { pid, nome } = item as Record<string, unknown>;
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid <= 0x3fffffff && typeof nome === 'string' && NOME.test(nome)) {
        saida.push({ pid, nome });
      }
    }
    return saida;
  } catch {
    return [];
  }
}

export function serializarRegistro(filhos: readonly FilhoRegistrado[]): string {
  return JSON.stringify(filhos);
}

/**
 * `cmdline` é o conteúdo cru de `/proc/<pid>/cmdline` (argumentos separados por
 * NUL). O processo é nosso se o executável é `pw-loopback` E o `-n` é o nome
 * que registramos.
 */
export function cmdlineConfere(filho: FilhoRegistrado, cmdline: string): boolean {
  const argv = cmdline.split('\0');
  if (argv[0] === undefined || basename(argv[0]) !== 'pw-loopback') return false;
  const i = argv.indexOf('-n');
  return i >= 0 && argv[i + 1] === filho.nome;
}
