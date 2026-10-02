import type { AudioCue } from '../core/ports/audio-cue.js';
import type { Storage } from '../core/ports/storage.js';

/**
 * Os sons do produto, gerados — não tocados de arquivo.
 *
 * Um WAV pesaria dezenas de KB para soar igual a meia dúzia de nós de Web
 * Audio. A §10 é explícita sobre isso, e o custo aqui é literalmente zero byte
 * no fio.
 *
 * O `AudioContext` só nasce no primeiro estouro: criá-lo antes do gesto do
 * usuário deixa um contexto `suspended` pendurado em toda visita e é
 * exatamente o que a política de autoplay existe para impedir.
 */
const CHAVE_MUDO = 'tela.mudo';

/**
 * Ataque curto e queda exponencial até o silêncio: o formato de uma nota
 * tocada, e não de um tom ligado e desligado (que estala nas pontas).
 */
function envelope(ctx: AudioContext, inicio: number, ataque: number, pico: number, duracao: number): GainNode {
  const ganho = ctx.createGain();
  ganho.gain.setValueAtTime(0, inicio);
  ganho.gain.linearRampToValueAtTime(pico, inicio + ataque);
  ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + duracao);
  return ganho;
}

export function makeWebAudioCue(storage: Storage): AudioCue {
  let contexto: AudioContext | null = null;
  let mudo = storage.get(CHAVE_MUDO) === 'sim';

  const abre = (): AudioContext | null => {
    if (contexto !== null) return contexto;
    const Construtor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Construtor === undefined) return null;
    contexto = new Construtor();
    return contexto;
  };

  return {
    estouro() {
      if (mudo) return;
      const ctx = abre();
      if (ctx === null) return;
      void ctx.resume();
      const agora = ctx.currentTime;
      // Tudo passa por um ganho só: o volume do sinal inteiro se ajusta aqui.
      const mestre = ctx.createGain();
      mestre.gain.value = 0.8;
      mestre.connect(ctx.destination);
      const descarta: AudioNode[] = [mestre];

      // 1. O baque do tubo ligando: seno descendo de 140 a 55 Hz em 0,12 s.
      // Grave e curto, sente-se mais do que se ouve — não briga com a call.
      const baque = ctx.createOscillator();
      baque.type = 'sine';
      baque.frequency.setValueAtTime(140, agora);
      baque.frequency.exponentialRampToValueAtTime(55, agora + 0.12);
      const ganhoBaque = envelope(ctx, agora, 0.005, 0.16, 0.18);
      baque.connect(ganhoBaque).connect(mestre);
      baque.start(agora);
      baque.stop(agora + 0.2);
      descarta.push(baque, ganhoBaque);

      // 2. Um resto de chiado, bem baixo e sem o agudo: a assinatura do
      // produto continua ali, mas como textura e não como estouro.
      const amostras = Math.floor(ctx.sampleRate * 0.25);
      const buffer = ctx.createBuffer(1, amostras, ctx.sampleRate);
      const canal = buffer.getChannelData(0);
      for (let i = 0; i < amostras; i += 1) canal[i] = Math.random() * 2 - 1;
      const ruido = ctx.createBufferSource();
      ruido.buffer = buffer;
      const banda = ctx.createBiquadFilter();
      banda.type = 'bandpass';
      banda.frequency.value = 1800;
      banda.Q.value = 0.8;
      const ganhoRuido = envelope(ctx, agora, 0.01, 0.025, 0.22);
      ruido.connect(banda).connect(ganhoRuido).connect(mestre);
      ruido.start(agora);
      ruido.stop(agora + 0.25);
      descarta.push(ruido, banda, ganhoRuido);

      // 3. O arpejo: lá maior subindo (mi, lá, dó#, mi), triangular — o timbre
      // de console antigo, redondo, sem a aspereza da quadrada. A última nota
      // fica um pouco mais, e uma senoide uma oitava acima dá o brilho.
      const NOTAS = [659.25, 880, 1108.73, 1318.51];
      NOTAS.forEach((frequencia, i) => {
        const inicio = agora + 0.06 + i * 0.07;
        const ultima = i === NOTAS.length - 1;
        const duracao = ultima ? 0.42 : 0.16;
        const corpo = ctx.createOscillator();
        corpo.type = 'triangle';
        corpo.frequency.value = frequencia;
        const brilho = ctx.createOscillator();
        brilho.type = 'sine';
        brilho.frequency.value = frequencia * 2;
        const ganhoCorpo = envelope(ctx, inicio, 0.008, 0.07, duracao);
        const ganhoBrilho = envelope(ctx, inicio, 0.008, 0.015, duracao * 0.7);
        corpo.connect(ganhoCorpo).connect(mestre);
        brilho.connect(ganhoBrilho).connect(mestre);
        corpo.start(inicio);
        brilho.start(inicio);
        corpo.stop(inicio + duracao + 0.02);
        brilho.stop(inicio + duracao + 0.02);
        descarta.push(corpo, brilho, ganhoCorpo, ganhoBrilho);
        if (ultima) corpo.onended = () => descarta.forEach((no) => no.disconnect());
      });
    },

    bipe() {
      if (mudo) return;
      const ctx = abre();
      if (ctx === null) return;
      void ctx.resume();
      // Subida de quinta, 90 ms cada: pergunta, não alarme. Triangular é
      // mais redonda que quadrada e não briga com o som do jogo.
      const agora = ctx.currentTime;
      [880, 1320].forEach((frequencia, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = frequencia;
        const ganho = ctx.createGain();
        const inicio = agora + i * 0.11;
        ganho.gain.setValueAtTime(0, inicio);
        ganho.gain.linearRampToValueAtTime(0.09, inicio + 0.01);
        ganho.gain.linearRampToValueAtTime(0, inicio + 0.09);
        osc.connect(ganho).connect(ctx.destination);
        osc.start(inicio);
        osc.stop(inicio + 0.1);
        osc.onended = () => {
          osc.disconnect();
          ganho.disconnect();
        };
      });
    },

    estaMudo: () => mudo,

    alternaMudo() {
      mudo = !mudo;
      storage.set(CHAVE_MUDO, mudo ? 'sim' : 'nao');
    },
  };
}
