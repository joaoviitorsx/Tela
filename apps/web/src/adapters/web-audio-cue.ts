import type { AudioCue } from '../core/ports/audio-cue.js';
import type { Storage } from '../core/ports/storage.js';

/**
 * O chiado, gerado — não tocado de arquivo.
 *
 * Um WAV de meio segundo de ruído filtrado pesaria uns 40 KB para soar igual a
 * quatro nós de Web Audio. A §10 é explícita sobre isso, e o custo aqui é
 * literalmente zero byte no fio.
 *
 * O `AudioContext` só nasce no primeiro estouro: criá-lo antes do gesto do
 * usuário deixa um contexto `suspended` pendurado em toda visita e é
 * exatamente o que a política de autoplay existe para impedir.
 */
const CHAVE_MUDO = 'tela.mudo';

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

      // Meio segundo de ruído branco em laço. Mais curto que isso e o laço
      // começa a soar como um zumbido de tom definido.
      const amostras = Math.floor(ctx.sampleRate * 0.5);
      const buffer = ctx.createBuffer(1, amostras, ctx.sampleRate);
      const canal = buffer.getChannelData(0);
      for (let i = 0; i < amostras; i += 1) canal[i] = Math.random() * 2 - 1;

      const fonte = ctx.createBufferSource();
      fonte.buffer = buffer;
      fonte.loop = true;

      // Passa-baixa em 4 kHz: ruído branco cru é agudo e agressivo; cortado
      // ali em cima, vira o chiado de tubo, que é o som que o produto tem.
      const filtro = ctx.createBiquadFilter();
      filtro.type = 'lowpass';
      filtro.frequency.value = 4000;
      filtro.Q.value = 0.7;

      const ganho = ctx.createGain();
      const agora = ctx.currentTime;
      ganho.gain.setValueAtTime(0, agora);
      ganho.gain.linearRampToValueAtTime(0.12, agora + 0.02);
      ganho.gain.linearRampToValueAtTime(0, agora + 0.18);

      fonte.connect(filtro).connect(ganho).connect(ctx.destination);
      fonte.start(agora);
      fonte.stop(agora + 0.2);
      fonte.onended = () => {
        fonte.disconnect();
        filtro.disconnect();
        ganho.disconnect();
      };
    },

    estaMudo: () => mudo,

    alternaMudo() {
      mudo = !mudo;
      storage.set(CHAVE_MUDO, mudo ? 'sim' : 'nao');
    },
  };
}
