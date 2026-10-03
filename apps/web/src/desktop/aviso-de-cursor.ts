import type { FonteDeCaptura, PlataformaDesktop } from './ponte.js';

/**
 * Jogos em que capturar a JANELA no Windows faz o cursor SUMIR para quem
 * joga. O League of Legends em tela cheia é o caso relatado (o nosso e o de
 * quem usa OBS ou a Discord): a captura de janela do Windows (Windows
 * Graphics Capture, a mesma do Chromium) e o cursor do jogo em tela cheia
 * não convivem. A captura da TELA não tem o problema, e o modo "Sem bordas"
 * do jogo também resolve.
 *
 * Pelo título da janela: "League of Legends" (o cliente) e "League of
 * Legends (TM) Client" (a partida). Um jogo novo com o mesmo defeito entra
 * aqui, com o relato que o trouxe.
 */
const JOGOS_QUE_ESCONDEM_O_CURSOR: readonly RegExp[] = [/league of legends/i];

export function avisoDeCursor(fonte: Pick<FonteDeCaptura, 'nome' | 'tipo'>, plataforma: PlataformaDesktop): string | null {
  if (plataforma !== 'win32' || fonte.tipo !== 'janela') return null;
  if (!JOGOS_QUE_ESCONDEM_O_CURSOR.some((re) => re.test(fonte.nome))) return null;
  return 'No LoL em tela cheia, transmitir a JANELA faz o Windows esconder o seu cursor dentro do jogo. Transmita a TELA, ou deixe o jogo em "Sem bordas" (Configurações > Vídeo > Modo de janela).';
}
