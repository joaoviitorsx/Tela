import type { AudioGain, EstadoGrafo } from '../core/ports/audio-gain.js';

type ContextCtor = new (options?: AudioContextOptions) => AudioContext;

function estadoDe(ctx: AudioContext | null): EstadoGrafo {
  if (ctx === null) return 'indisponivel';
  // `interrupted` é do Safari e não está no tipo do DOM.
  switch (ctx.state as AudioContextState | 'interrupted') {
    case 'running':
      return 'ativo';
    case 'suspended':
      return 'suspenso';
    case 'interrupted':
      return 'interrompido';
    case 'closed':
      return 'fechado';
    default:
      return 'indisponivel';
  }
}

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
 * escolher outra força uma reamostragem que não serve para nada aqui. É um
 * pedido, não uma prova: o contexto pode reamostrar mesmo assim.
 *
 * O grafo não se conecta ao `ctx.destination`: tocar a captura no alto-falante
 * de quem transmite faria o som do jogo voltar para o jogo.
 */
export function makeBrowserAudioGain(): AudioGain {
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let destino: MediaStreamAudioDestinationNode | null = null;
  let origem: MediaStreamAudioSourceNode | null = null;
  /** A trilha crua tem que continuar VIVA: ela alimenta o grafo. */
  let entrada: MediaStreamTrack | null = null;
  /** No fallback, a trilha crua É a transmitida — e o mudo é aplicado nela. */
  let crua: MediaStreamTrack | null = null;
  let valor = 1;
  let ligado = false;
  const ouvintes = new Set<(estado: EstadoGrafo) => void>();

  const avisar = (): void => {
    const estado = estadoDe(ctx);
    for (const ouvinte of ouvintes) ouvinte(estado);
  };

  const desmontar = (): void => {
    if (ctx !== null) ctx.onstatechange = null;
    origem?.disconnect();
    gain?.disconnect();
    // A trilha de entrada é nossa responsabilidade: quem publicou recebeu a
    // de SAÍDA e só sabe parar aquela.
    entrada?.stop();
    crua?.stop();
    for (const t of destino?.stream.getTracks() ?? []) t.stop();
    void ctx?.close().catch(() => undefined);
    ctx = null;
    gain = null;
    destino = null;
    origem = null;
    entrada = null;
    crua = null;
    ligado = false;
  };

  return {
    get ativo() {
      return ligado;
    },

    get estado() {
      return estadoDe(ctx);
    },

    onEstado(listener) {
      ouvintes.add(listener);
      return () => ouvintes.delete(listener);
    },

    attach(track) {
      // Um grafo por sessão, sempre: o anterior sai antes do novo entrar.
      if (ctx !== null || crua !== null) desmontar();

      const Ctor: ContextCtor | undefined =
        typeof window === 'undefined'
          ? undefined
          : (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: ContextCtor }).webkitAudioContext);
      if (Ctor === undefined) {
        crua = track;
        track.enabled = valor > 0;
        return track;
      }

      try {
        ctx = new Ctor({ sampleRate: 48_000 });
        ctx.onstatechange = avisar;
        origem = ctx.createMediaStreamSource(new MediaStream([track]));
        gain = ctx.createGain();
        gain.gain.value = valor;
        destino = ctx.createMediaStreamDestination();
        origem.connect(gain);
        gain.connect(destino);

        // Autoplay policy também vale para AudioContext. A transmissão começa
        // num clique, então isto normalmente já vem 'running' — e quando não
        // vem, o estado `suspenso` chega à sessão pelo `onstatechange`.
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

        const saida = destino.stream.getAudioTracks()[0];
        if (saida === undefined) throw new Error('destino sem trilha');

        entrada = track;
        ligado = true;
        avisar();
        return saida;
      } catch {
        // Sem grafo, transmite a trilha crua. O usuário perde o controle de
        // volume; não perde o som — e não perde o MUDO.
        if (ctx !== null) ctx.onstatechange = null;
        void ctx?.close().catch(() => undefined);
        ctx = null;
        gain = null;
        destino = null;
        origem = null;
        ligado = false;
        crua = track;
        track.enabled = valor > 0;
        avisar();
        return track;
      }
    },

    set(value) {
      valor = Math.min(1, Math.max(0, value));
      if (crua !== null) crua.enabled = valor > 0;
      // `setTargetAtTime` em vez de atribuição direta: pulo instantâneo de
      // ganho produz clique audível na trilha.
      if (gain !== null && ctx !== null) {
        gain.gain.setTargetAtTime(valor, ctx.currentTime, 0.015);
      }
    },

    async retomar() {
      if (ctx === null) return 'indisponivel';
      try {
        await ctx.resume();
      } catch {
        // Fora de gesto o navegador recusa; o estado abaixo diz o resultado.
      }
      return estadoDe(ctx);
    },

    close() {
      desmontar();
      avisar();
    },
  };
}
