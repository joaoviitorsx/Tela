/**
 * Os efeitos de verdade do "só o jogo" no Linux: processos do PipeWire.
 *
 * Fino de propósito — a lógica está em `som-jogo-linux.ts`, que recebe isto
 * por injeção. Sem shell em lugar nenhum: `execFile` e `spawn` com argumentos
 * em lista (`comandos-pw.ts` os monta e valida).
 */
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cmdlineConfere, type FilhoRegistrado, lerRegistro, serializarRegistro } from './filhos-registrados.js';
import type { EfeitosLinux, ProcessoDoSink, ResultadoDeComando } from './som-jogo-linux.js';

/** O `pw-dump` de uma máquina cheia passa de 1 MB; 64 MB é teto, não alvo. */
const MAXIMO_DA_SAIDA = 64 * 1024 * 1024;
const PRAZO_DO_COMANDO_MS = 5000;

/**
 * O registro em disco dos `pw-loopback` que ESTE app subiu (S-12). `ler`/
 * `gravar` são injetados: o main usa um arquivo em `userData`, o teste, memória.
 */
export type ArmazemDoRegistro = {
  ler(): string | null;
  gravar(texto: string): void;
};

export function efeitosLinux(
  pidsDoTela: () => ReadonlySet<number>,
  armazem: ArmazemDoRegistro = { ler: () => null, gravar: () => undefined },
  lerCmdline: (pid: number) => string | null = cmdlineDoProcesso,
  sinalizar: (pid: number) => void = sigterm,
): EfeitosLinux {
  /** Os filhos desta execução que ainda vivem: nunca são "órfãos". */
  const vivos = new Map<number, FilhoRegistrado>();
  const gravarRegistro = (): void => {
    try {
      armazem.gravar(serializarRegistro([...vivos.values()]));
    } catch {
      // Sem o registro só se perde a limpeza pós-queda; o som não depende dele.
    }
  };
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
      const nome = c.args[c.args.indexOf('-n') + 1];
      const pid = filho.pid;
      if (pid !== undefined && nome !== undefined && /^tela_[a-z_]{1,40}$/.test(nome)) {
        vivos.set(pid, { pid, nome });
        gravarRegistro();
      }
      const ouvintes: Array<(codigo: number | null) => void> = [];
      let saiu = false;
      const sair = (codigo: number | null): void => {
        if (saiu) return;
        saiu = true;
        if (pid !== undefined && vivos.delete(pid)) gravarRegistro();
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

    encerrarOrfaos() {
      // Só pids que ESTE app registrou numa execução anterior e que, agora, ainda
      // são um `pw-loopback` com o nosso `-n`. Nunca um pid vindo do PipeWire.
      let mortos = 0;
      for (const f of lerRegistro(armazem.ler())) {
        if (vivos.has(f.pid)) continue;
        const cmdline = lerCmdline(f.pid);
        if (cmdline === null || !cmdlineConfere(f, cmdline)) continue;
        sinalizar(f.pid);
        mortos += 1;
      }
      gravarRegistro();
      return mortos;
    },

    pidsDoTela: pidsDoTela,
  };
}

function cmdlineDoProcesso(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'latin1');
  } catch {
    return null;
  }
}

function sigterm(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // já tinha saído
  }
}
