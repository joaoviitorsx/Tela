import type { AudioGain } from '../core/ports/audio-gain.js';

type ContextCtor = new (options?: AudioContextOptions) => AudioContext;

/**
 * Ganho no caminho de saída, via Web Audio.
 *
 * A trilha capturada vira fonte de um grafo `origem → ganho → destino`, e o
 * que sai do destino é o que vai para os peers. O `GainNode` é o único jeito
 * de mexer no volume do que é ENVIADO — mexer no `<video>` local só mudaria o
 * que o próprio transmissor ouve, que é exatamente a confusão que motivou
 * este arquivo.
 *
 * 48 kHz de propósito: é a taxa em que a captura entrega, e deixar o contexto
 * escolher outra força uma reamostragem que não serve para nada aqui.
 */
export function makeBrowserAudioGain(): AudioGain {
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let destino: MediaStreamAudioDestinationNode | null = null;
  let origem: MediaStreamAudioSourceNode | null = null;
  /** A trilha crua tem que continuar VIVA: ela alimenta o grafo. */
  let entrada: MediaStreamTrack | null = null;
  let valor = 1;
  let ligado = false;

  return {
    get ativo() {
      return ligado;
    },

    attach(track) {
      const Ctor: ContextCtor | undefined =
        typeof window === 'undefined'
          ? undefined
          : (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: ContextCtor }).webkitAudioContext);
      if (Ctor === undefined) return track;

      try {
        ctx = new Ctor({ sampleRate: 48_000 });
        origem = ctx.createMediaStreamSource(new MediaStream([track]));
        gain = ctx.createGain();
        gain.gain.value = valor;
        destino = ctx.createMediaStreamDestination();
        origem.connect(gain);
        gain.connect(destino);

        // Autoplay policy também vale para AudioContext. A transmissão começa
        // num clique, então isto normalmente já vem 'running'.
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

        const saida = destino.stream.getAudioTracks()[0];
        if (saida === undefined) throw new Error('destino sem trilha');

        entrada = track;
        ligado = true;
        return saida;
      } catch {
        // Sem grafo, transmite a trilha crua. O usuário perde o controle de
        // volume; não perde o som — que é o que ele veio fazer aqui.
        void ctx?.close().catch(() => undefined);
        ctx = null;
        gain = null;
        destino = null;
        origem = null;
        ligado = false;
        return track;
      }
    },

    set(value) {
      valor = Math.min(1, Math.max(0, value));
      // `setTargetAtTime` em vez de atribuição direta: pulo instantâneo de
      // ganho produz clique audível na trilha.
      if (gain !== null && ctx !== null) {
        gain.gain.setTargetAtTime(valor, ctx.currentTime, 0.015);
      }
    },

    close() {
      origem?.disconnect();
      gain?.disconnect();
      // A trilha de entrada é nossa responsabilidade: quem publicou recebeu a
      // de SAÍDA e só sabe parar aquela.
      entrada?.stop();
      for (const t of destino?.stream.getTracks() ?? []) t.stop();
      void ctx?.close().catch(() => undefined);
      ctx = null;
      gain = null;
      destino = null;
      origem = null;
      entrada = null;
      ligado = false;
    },
  };
}
