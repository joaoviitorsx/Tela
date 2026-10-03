import type { FonteDeCaptura, PlataformaDesktop } from './ponte.js';

/**
 * Jogos que ESCONDEM o próprio cursor, para quem joga, em tela cheia com
 * uma captura ativa. O League of Legends é o caso relatado: no app o cursor
 * sumiu e, transmitindo pelo navegador, não — o que separa os dois é a
 * fonte: o seletor do app leva à JANELA do jogo (Windows Graphics Capture),
 * o do Chrome sugere a TELA INTEIRA (DXGI fora do Windows 11 24H2). O mesmo
 * relato existe no OBS (threads 193520, 133130 e 153266 do fórum). Duas
 * saídas: a aba TELAS, ou o jogo em "Sem bordas" — que resolve nos relatos
 * mesmo onde a TELA também passa pelo WGC (24H2+).
 *
 * Por isso o aviso não depende da fonte escolhida: o jogo aberto já basta.
 * Título EXATO (cliente e partida): uma aba de navegador "League of Legends –
 * Wiki" não conta. Um jogo novo com o mesmo defeito entra aqui, com o relato
 * que o trouxe.
 */
const JANELAS_DE_JOGO_QUE_ESCONDEM_O_CURSOR: readonly RegExp[] = [/^league of legends( \(tm\) client)?$/i];

export const AVISO_DE_CURSOR =
  'League of Legends aberto: com o jogo em TELA CHEIA, transmitir a JANELA dele pode sumir com o seu cursor dentro do jogo (limitação do Windows; acontece também no OBS). Escolha a aba TELAS, ou deixe o LoL em "Sem bordas" (na partida: Esc > Vídeo > Modo de janela).';

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
