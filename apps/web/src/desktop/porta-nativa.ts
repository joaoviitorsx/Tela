import { MARCA_DA_PORTA } from './ponte.js';

/**
 * A porta por onde os quadros do `tela-captura` chegam ao codificador externo
 * (`adapters/codificador-externo.ts`), do lado da página.
 *
 * O codificador nasce com o transporte, antes de a pessoa escolher o que
 * transmitir; o processo nativo (e a `MessagePort` dele) só existe depois.
 * Esta porta é o PROXY entre os dois: o codificador fala com ela desde o
 * início, e ela é ligada à porta real quando a captura sobe — e religada a
 * outra na troca de fonte. Ordens sem porta ficam guardadas; mensagens sem
 * ouvinte (o `pronto`, que chega antes de o codificador ser iniciado) também.
 *
 * As formas abaixo são estruturais, copiadas do adapter: `src/desktop/` não
 * importa `adapters/` (lint); quem liga os dois é o container.
 */
export type OrdemParaNativo = { readonly tipo: 'ordem'; readonly linha: string };

export type MensagemDoNativo = { readonly tipo: string };

export type PortaNativa = {
  postMessage(m: OrdemParaNativo): void;
  onmessage: ((e: { readonly data: MensagemDoNativo }) => void) | null;
};

/** O mínimo de uma `MessagePort` do DOM que isto usa — injetável nos testes. */
export type PortaReal = {
  postMessage(m: unknown): void;
  onmessage: ((e: { readonly data: unknown }) => void) | null;
  close(): void;
};

export type LigacaoNativa = {
  /** O que o codificador recebe. */
  readonly porta: PortaNativa;
  /** Liga à porta da sessão `id`, fechando a anterior. */
  ligar(id: number, real: PortaReal): void;
  /** Desliga só se a porta atual for a da sessão `id`. */
  desligar(id: number): void;
  /** A porta que o main mandou para a sessão `id`, assim que chegar. */
  aguardar(id: number): Promise<PortaReal>;
};

/** Ordens antes de haver porta: poucas (`alvo`, `chave`), e guardadas na ordem. */
const MAXIMO_DE_ORDENS_GUARDADAS = 16;
/** Mensagens antes de haver ouvinte: só eventos, e só os últimos. */
const MAXIMO_DE_EVENTOS_GUARDADOS = 32;

/** O mínimo de `window` que isto usa: as portas chegam por `message`. */
export type JanelaDePortas = {
  addEventListener(tipo: 'message', ouvinte: (e: { readonly data: unknown; readonly ports: readonly PortaReal[] }) => void): void;
};

function ehMensagem(x: unknown): x is MensagemDoNativo {
  return typeof x === 'object' && x !== null && typeof (x as { tipo?: unknown }).tipo === 'string';
}

export function makeLigacaoNativa(janela: JanelaDePortas): LigacaoNativa {
  let real: PortaReal | null = null;
  let idAtual: number | null = null;
  let ouvinte: PortaNativa['onmessage'] = null;
  const ordensGuardadas: OrdemParaNativo[] = [];
  const eventosGuardados: MensagemDoNativo[] = [];

  /** Portas que chegaram antes de alguém esperar, e esperas sem porta. */
  const chegadas = new Map<number, PortaReal>();
  const esperas = new Map<number, (p: PortaReal) => void>();

  janela.addEventListener('message', (e) => {
    const dados = e.data as { tipo?: unknown; id?: unknown } | null;
    if (typeof dados !== 'object' || dados === null || dados.tipo !== MARCA_DA_PORTA) return;
    const porta = e.ports[0];
    if (typeof dados.id !== 'number' || porta === undefined) return;
    const espera = esperas.get(dados.id);
    if (espera !== undefined) {
      esperas.delete(dados.id);
      espera(porta);
    } else {
      chegadas.set(dados.id, porta);
    }
  });

  const entregar = (m: MensagemDoNativo): void => {
    if (ouvinte !== null) {
      ouvinte({ data: m });
      return;
    }
    // Quadros sem ouvinte envelheceriam; eventos (o `pronto`) são o que importa.
    if (m.tipo !== 'evento') return;
    eventosGuardados.push(m);
    if (eventosGuardados.length > MAXIMO_DE_EVENTOS_GUARDADOS) eventosGuardados.shift();
  };

  const porta: PortaNativa = {
    postMessage(m) {
      if (real !== null) {
        real.postMessage(m);
        return;
      }
      // Sem processo, `parar` não tem a quem parar.
      if (m.linha === 'parar') return;
      ordensGuardadas.push(m);
      if (ordensGuardadas.length > MAXIMO_DE_ORDENS_GUARDADAS) ordensGuardadas.shift();
    },
    get onmessage() {
      return ouvinte;
    },
    set onmessage(fn) {
      ouvinte = fn;
      if (fn === null) return;
      const pendentes = eventosGuardados.splice(0);
      for (const m of pendentes) fn({ data: m });
    },
  };

  return {
    porta,
    ligar(id, novaPorta) {
      if (real !== null && real !== novaPorta) real.close();
      real = novaPorta;
      idAtual = id;
      novaPorta.onmessage = (e) => {
        if (real === novaPorta && ehMensagem(e.data)) entregar(e.data);
      };
      const pendentes = ordensGuardadas.splice(0);
      for (const m of pendentes) novaPorta.postMessage(m);
    },
    desligar(id) {
      if (idAtual !== id || real === null) return;
      real.onmessage = null;
      real.close();
      real = null;
      idAtual = null;
    },
    aguardar(id) {
      const pronta = chegadas.get(id);
      if (pronta !== undefined) {
        chegadas.delete(id);
        return Promise.resolve(pronta);
      }
      return new Promise((resolver) => esperas.set(id, resolver));
    },
  };
}
