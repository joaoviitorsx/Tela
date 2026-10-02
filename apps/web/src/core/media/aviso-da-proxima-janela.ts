import type { SystemAudioMode } from '../ports/platform.js';

/**
 * O que dizer ANTES do clique que abre o seletor do navegador (B-08).
 *
 * A escolha da tela e a caixa "compartilhar áudio do sistema" acontecem lá,
 * depois de IR AO AR, e é a decisão que mais quebra o som. Dito antes, a pessoa
 * chega à janela sabendo o que marcar.
 */
export function avisoDaProximaJanela(modo: SystemAudioMode, noApp: boolean): string {
  if (noApp) return 'Na próxima janela, escolha a tela ou o jogo. O som segue o que você marcou acima.';
  switch (modo) {
    case 'display-media':
      return 'Na próxima janela, escolha a JANELA do jogo e marque o áudio: vai só o jogo, sem a call. Tela inteira leva a call junto.';
    case 'monitor-device':
      return 'Na próxima janela, escolha a tela ou o jogo. O som vem da entrada escolhida aqui, não da janela.';
    case 'unsupported':
      return 'Na próxima janela, escolha a tela ou o jogo. Neste sistema o som do jogo não vai junto.';
  }
}
