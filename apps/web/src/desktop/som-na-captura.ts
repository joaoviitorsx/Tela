import { ok } from '../core/domain/result.js';
import type { ScreenCapture } from '../core/ports/screen-capture.js';

/**
 * Tira o áudio da captura de TELA no app (D3).
 *
 * O som do app vem todo do componente de som (`audio-desktop.ts`): "Sistema"
 * é tudo que toca MENOS a call, "Só o jogo" é um programa só. O áudio que o
 * `getDisplayMedia` traria é o `loopback` do Electron — o sistema inteiro, com
 * a call do Discord junto, justo o que nenhum dos modos quer. A sessão sempre
 * pede (`systemAudio: true`); aqui o pedido vira "sem áudio", e o main também
 * nunca o entrega (`fontes-de-captura.ts`).
 *
 * E cala um aviso falso: a sessão avisa "sem áudio: o som do sistema só
 * acompanha a tela inteira" quando a superfície é uma janela e não há trilha.
 * No app isso nunca é verdade — o som não depende do que se captura —, então
 * a superfície passa a `desconhecido` (que não avisa). Se o som falhar, quem
 * diz o motivo é o rótulo "VAI SAIR · SEM SOM · …".
 */
export function semSomNaCaptura(screen: ScreenCapture): ScreenCapture {
  return {
    isSupported: () => screen.isSupported(),
    async request(options) {
      const r = await screen.request({ ...options, systemAudio: false });
      if (!r.ok) return r;
      // Defesa: uma trilha que viesse mesmo assim seria a do sistema inteiro.
      r.value.audio?.stop();
      return ok({ ...r.value, audio: null, surface: 'desconhecido' as const });
    },
  };
}
