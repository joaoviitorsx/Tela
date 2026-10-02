import type { PortaReal } from './porta-nativa.js';
import { CANAIS_DO_PCM, TAXA_DO_PCM, blocoValido } from './pcm-som.js';

/**
 * Do PCM da `MessagePort` a uma `MediaStreamTrack` (D3, PLANO-desktop §4.1):
 *
 *     porta ──► AudioWorklet (anel de ~60 ms, compensa deriva)
 *                  └► MediaStreamAudioDestinationNode ─► trilha
 *
 * A trilha entra na sessão como qualquer fonte de áudio (o grafo de ganho
 * da sessão a envolve depois). `parar()` fecha tudo; o fim da fonte (o jogo
 * fechou, o componente caiu) é `encerrar()`, que para a trilha e dispara
 * `ended` — o mesmo caminho pelo qual uma captura real avisa a sessão.
 *
 * As partes do navegador (AudioContext, worklet) vêm por injeção: a ligação é
 * testada com fakes; o som de verdade só se confere com ouvido, no Windows.
 */
export type NoDeWorklet = {
  readonly port: { postMessage(m: unknown, transferir?: readonly unknown[]): void };
  connect(destino: unknown): unknown;
  disconnect(): void;
};

export type ContextoDePcm = {
  readonly audioWorklet: { addModule(url: string): Promise<void> };
  resume(): Promise<void>;
  close(): Promise<void>;
  criarNo(): NoDeWorklet;
  criarDestino(): { readonly trilha: MediaStreamTrack; readonly no: unknown };
};

export type TrilhaDePcm = {
  readonly trilha: MediaStreamTrack;
  /** O som acabou por fora (o jogo fechou): para a trilha e dispara `ended`. */
  encerrar(): void;
};

export type DepsDaTrilhaPcm = {
  readonly criarContexto: () => ContextoDePcm;
  readonly urlDoWorklet: string;
};

/** O contexto de verdade, a 48 kHz: o mesmo relógio que o addon entrega, sem reamostrar. */
export function contextoDoNavegador(): ContextoDePcm {
  const ctx = new AudioContext({ sampleRate: TAXA_DO_PCM, latencyHint: 'interactive' });
  return {
    audioWorklet: ctx.audioWorklet,
    resume: () => ctx.resume(),
    close: () => ctx.close(),
    criarNo: () => {
      const no = new AudioWorkletNode(ctx, 'tela-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [CANAIS_DO_PCM] });
      return {
        port: no.port,
        connect: (destino) => no.connect(destino as AudioNode),
        disconnect: () => no.disconnect(),
      };
    },
    criarDestino: () => {
      const d = ctx.createMediaStreamDestination();
      const trilha = d.stream.getAudioTracks()[0];
      if (trilha === undefined) throw new Error('sem trilha de áudio no destino');
      return { trilha, no: d };
    },
  };
}

export async function criarTrilhaDePcm(porta: PortaReal, deps: DepsDaTrilhaPcm): Promise<TrilhaDePcm> {
  const ctx = deps.criarContexto();
  await ctx.audioWorklet.addModule(deps.urlDoWorklet);
  const no = ctx.criarNo();
  const destino = ctx.criarDestino();
  no.connect(destino.no);
  await ctx.resume();

  // Direto da porta ao worklet; se o navegador recusar a transferência, a
  // thread principal repassa bloco a bloco.
  try {
    no.port.postMessage({ tipo: 'porta', porta }, [porta]);
  } catch {
    porta.onmessage = (e) => {
      const bloco = blocoValido(e.data);
      if (bloco !== null) no.port.postMessage({ tipo: 'pcm', dados: bloco.dados });
    };
  }

  const trilha = destino.trilha;
  let fechado = false;
  const fechar = (): void => {
    if (fechado) return;
    fechado = true;
    try {
      porta.close();
    } catch {
      // a porta pode já ter sido transferida ao worklet e fechada com ele
    }
    no.disconnect();
    void ctx.close().catch(() => undefined);
  };

  // Parar a trilha (a sessão acabou) desmonta o grafo — senão o contexto fica aberto.
  const pararTrilha = trilha.stop.bind(trilha);
  trilha.stop = () => {
    pararTrilha();
    fechar();
  };

  return {
    trilha,
    encerrar: () => {
      if (fechado) return;
      trilha.stop();
      trilha.dispatchEvent(new Event('ended'));
    },
  };
}
