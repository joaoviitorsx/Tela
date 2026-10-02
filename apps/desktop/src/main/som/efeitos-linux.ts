/**
 * Os efeitos de verdade do "só o jogo" no Linux: processos do PipeWire.
 *
 * Fino de propósito — a lógica está em `som-jogo-linux.ts`, que recebe isto
 * por injeção. Sem shell em lugar nenhum: `execFile` e `spawn` com argumentos
 * em lista (`comandos-pw.ts` os monta e valida).
 */
import { execFile, spawn } from 'node:child_process';
import type { EfeitosLinux, ProcessoDoSink, ResultadoDeComando } from './som-jogo-linux.js';

/** O `pw-dump` de uma máquina cheia passa de 1 MB; 64 MB é teto, não alvo. */
const MAXIMO_DA_SAIDA = 64 * 1024 * 1024;
const PRAZO_DO_COMANDO_MS = 5000;

export function efeitosLinux(pidsDoTela: () => ReadonlySet<number>): EfeitosLinux {
  return {
    executar(c): Promise<ResultadoDeComando> {
      return new Promise((resolver) => {
        execFile(
          c.cmd,
          [...c.args],
          { timeout: PRAZO_DO_COMANDO_MS, maxBuffer: MAXIMO_DA_SAIDA, encoding: 'utf8', windowsHide: true },
          (erro, stdout) => {
            // `erro.code` é o código de saída (número) ou `ENOENT` (texto):
            // ferramenta ausente e comando que falhou são "não funcionou".
            const codigo = erro === null ? 0 : typeof erro.code === 'number' ? erro.code : null;
            resolver({ codigo, saida: stdout });
          },
        );
      });
    },

    iniciarSink(c): ProcessoDoSink {
      const filho = spawn(c.cmd, [...c.args], { stdio: 'ignore', windowsHide: true });
      const ouvintes: Array<(codigo: number | null) => void> = [];
      let saiu = false;
      const sair = (codigo: number | null): void => {
        if (saiu) return;
        saiu = true;
        for (const o of ouvintes) o(codigo);
      };
      filho.on('exit', sair);
      // `spawn` de binário ausente não lança: avisa por `error`, e `exit` não vem.
      filho.on('error', () => sair(null));
      return {
        kill: (sinal) => filho.kill(sinal),
        aoSair(ouvinte) {
          if (saiu) ouvinte(null);
          else ouvintes.push(ouvinte);
        },
      };
    },

    agendar(fn, ms) {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },

    esperar: (ms) => new Promise((resolver) => setTimeout(resolver, ms)),

    matar(pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // já tinha saído
      }
    },

    pidsDoTela: pidsDoTela,
  };
}
