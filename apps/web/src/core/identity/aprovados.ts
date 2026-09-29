import type { Storage } from '../ports/storage.js';

/**
 * Quem o dono já aceitou, neste aparelho (ADR 0025).
 *
 * Guarda impressões — o sha256 da chave do navegador de cada espectador, que é
 * tudo o que o servidor mostra. Vale até o dono tirar
 * todo mundo: aí a lista zera e cada um pede de novo. O servidor não guarda
 * nada disto; se guardasse, precisaria de armazenamento durável só para isso.
 */
export const APROVADOS_KEY = 'tela.aprovados';

/**
 * Teto da lista. Um grupo de amigos cabe folgado; o teto só impede que anos
 * de transmissões sem renovar cresçam sem limite. Sai o mais antigo.
 */
const MAX_APROVADOS = 64;

export type Aprovados = {
  tem(impressao: string): boolean;
  aprovar(impressao: string): void;
  revogar(impressao: string): void;
  limpar(): void;
};

export function makeAprovados(storage: Storage): Aprovados {
  const ler = (): string[] => {
    const bruto = storage.get(APROVADOS_KEY);
    if (bruto === null) return [];
    try {
      const lista: unknown = JSON.parse(bruto);
      return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const gravar = (lista: readonly string[]): void => {
    storage.set(APROVADOS_KEY, JSON.stringify(lista.slice(-MAX_APROVADOS)));
  };
  return {
    tem: (impressao) => ler().includes(impressao),
    aprovar(impressao) {
      const lista = ler().filter((x) => x !== impressao);
      gravar([...lista, impressao]);
    },
    revogar(impressao) {
      gravar(ler().filter((x) => x !== impressao));
    },
    limpar: () => storage.remove(APROVADOS_KEY),
  };
}

/** Em memória: para quem não passa armazenamento (testes, simulador). */
export function aprovadosEmMemoria(): Aprovados {
  const lista = new Set<string>();
  return {
    tem: (i) => lista.has(i),
    aprovar: (i) => void lista.add(i),
    revogar: (i) => void lista.delete(i),
    limpar: () => lista.clear(),
  };
}
