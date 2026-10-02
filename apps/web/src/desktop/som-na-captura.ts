import { ok } from '../core/domain/result.js';
import type { ScreenCapture } from '../core/ports/screen-capture.js';
import type { SomDesktop } from './som-desktop.js';

/**
 * Faz a captura de TELA seguir a escolha de som (D3).
 *
 * No Windows o som do sistema vem junto da tela (`audio: 'loopback'` do
 * Electron, que o main só entrega quando a página PEDE áudio). A sessão sempre
 * pede (`systemAudio: true`); aqui o pedido vira o que a pessoa escolheu:
 * "só o jogo" e "sem som" NÃO pedem áudio à tela — senão a call viria junto
 * com o jogo, justo o que "só o jogo" existe para evitar.
 *
 * Também registra o que a captura realmente entregou no modo Sistema do
 * Windows, o único que não passa pelo adapter de áudio quando dá certo.
 *
 * E cala um aviso falso: a sessão avisa "sem áudio: o som do sistema só
 * acompanha a tela inteira" quando a superfície é uma janela e não há trilha.
 * Isso só é verdade no modo Sistema; com "só o jogo" ou "sem som" a janela é
 * o que a pessoa quis, e a superfície passa a `desconhecido` (que não avisa).
 */
export function comSomEscolhido(screen: ScreenCapture, som: Pick<SomDesktop, 'escolhaAtual' | 'registrar'>): ScreenCapture {
  return {
    isSupported: () => screen.isSupported(),
    async request(options) {
      const sistema = som.escolhaAtual().tipo === 'sistema';
      const r = await screen.request({ ...options, systemAudio: options.systemAudio && sistema });
      if (!r.ok) return r;
      if (sistema) {
        if (r.value.audio !== null) som.registrar({ situacao: 'ativo' });
        return r;
      }
      return ok({ ...r.value, surface: 'desconhecido' as const });
    },
  };
}
