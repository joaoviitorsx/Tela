/**
 * O `AudioWorkletProcessor` do "só o jogo" no Windows (D3): lê o PCM do anel
 * (`anel-pcm.ts`) e o entrega ao grafo de áudio, 128 quadros por vez.
 *
 * Roda no escopo do worklet — sem DOM, sem React, sem `window`. Duas formas de
 * receber o som:
 *
 * - `{ tipo: 'porta', porta }`: a `MessagePort` do utility process, transferida
 *   para cá. O PCM vai do processo nativo ao worklet SEM passar pela thread
 *   principal da página, que pode engasgar (React, layout) sem estalar o som;
 * - `{ tipo: 'pcm', dados }`: reserva, se o navegador não aceitar a porta no
 *   worklet — a thread principal repassa cada bloco.
 *
 * O Vite empacota este arquivo como módulo à parte (`?worker&url`); por isso
 * ele declara os poucos globais do worklet em vez de depender de uma lib.
 */
import { AnelPcm } from './anel-pcm.js';
import { ALVO_DO_ANEL_EM_QUADROS, blocoValido, CAPACIDADE_DO_ANEL_EM_QUADROS } from './pcm-som.js';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(opcoes?: unknown);
}
declare function registerProcessor(nome: string, processador: new (opcoes?: unknown) => AudioWorkletProcessor): void;

export const NOME_DO_PROCESSADOR = 'tela-pcm';

class ProcessadorDePcm extends AudioWorkletProcessor {
  private readonly anel = new AnelPcm({ capacidade: CAPACIDADE_DO_ANEL_EM_QUADROS, alvo: ALVO_DO_ANEL_EM_QUADROS });

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<unknown>) => {
      const d = e.data as { tipo?: unknown; porta?: unknown; dados?: unknown } | null;
      if (d === null || typeof d !== 'object') return;
      if (d.tipo === 'porta' && d.porta instanceof MessagePort) {
        d.porta.onmessage = (m: MessageEvent<unknown>) => this.empurrar(m.data);
      } else if (d.tipo === 'pcm') {
        this.empurrar(d);
      }
    };
  }

  private empurrar(mensagem: unknown): void {
    const m = mensagem as { dados?: unknown } | null;
    // O repasse da thread principal manda `{ tipo: 'pcm', dados }`; a porta, `{ t: 'pcm', n, dados }`.
    const bloco = blocoValido(m !== null && typeof m === 'object' && 'tipo' in m ? { t: 'pcm', n: 0, dados: m.dados } : mensagem);
    if (bloco !== null) this.anel.empurrar(bloco.dados);
  }

  process(_entradas: Float32Array[][], saidas: Float32Array[][]): boolean {
    const saida = saidas[0];
    const esq = saida?.[0];
    if (esq === undefined) return true;
    const dir = saida?.[1] ?? esq;
    this.anel.puxar(esq, dir);
    return true;
  }
}

registerProcessor(NOME_DO_PROCESSADOR, ProcessadorDePcm);
