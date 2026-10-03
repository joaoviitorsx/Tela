import type { FonteDeCaptura, PlataformaDesktop } from './ponte.js';

/**
 * Jogos que ESCONDEM o próprio cursor, para quem joga, em tela cheia com
 * uma captura ativa. O League of Legends é o caso relatado: em tela cheia o
 * cursor some com captura de janela E de tela — o mesmo relato existe no
 * OBS com Display Capture, Game Capture e captura de janela (threads
 * 153266, 133130, 193520 do fórum do OBS). No Windows 11 24H2 o Chromium
 * captura até a tela pelo mesmo Windows Graphics Capture, então trocar de
 * fonte não resolve. O que resolve nos relatos é o jogo em "Sem bordas".
 *
 * Por isso o aviso não depende da fonte escolhida: o jogo aberto já basta.
 * Título EXATO (cliente e partida): uma aba de navegador "League of Legends –
 * Wiki" não conta. Um jogo novo com o mesmo defeito entra aqui, com o relato
 * que o trouxe.
 */
const JANELAS_DE_JOGO_QUE_ESCONDEM_O_CURSOR: readonly RegExp[] = [/^league of legends( \(tm\) client)?$/i];

export const AVISO_DE_CURSOR =
  'League of Legends aberto: em TELA CHEIA o seu cursor pode sumir dentro do jogo enquanto você transmite (limitação do Windows; acontece também no OBS). Deixe o LoL em "Sem bordas": na partida, Esc > Vídeo > Modo de janela.';

/** O aviso, se algum jogo da lista está aberto. O(fontes × jogos), só com o seletor aberto. */
export function avisoDeCursor(
  fontes: readonly Pick<FonteDeCaptura, 'nome' | 'tipo'>[],
  plataforma: PlataformaDesktop,
): string | null {
  if (plataforma !== 'win32') return null;
  const aberto = fontes.some(
    (f) => f.tipo === 'janela' && JANELAS_DE_JOGO_QUE_ESCONDEM_O_CURSOR.some((re) => re.test(f.nome.trim())),
  );
  return aberto ? AVISO_DE_CURSOR : null;
}
