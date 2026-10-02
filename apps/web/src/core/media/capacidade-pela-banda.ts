import { FRAMERATE_POR_PRIORIDADE, P2P_LIMITS, type Prioridade, pisoDeBitrate } from '@tela/shared';
import { PRESET_IDS, presetById } from './presets.js';
import { UPLINK_SHARE } from './uplink-governor.js';

/**
 * Quantos espectadores o LINK paga agora (ADR 0030).
 *
 * A malha de banda (ADR 0015/0017) faz a sala inteira descer junto quando o
 * upload não dá para todos — e desce até o fundo da escada, onde não há mais
 * pixel para tirar. Com 50 espectadores num link de 10 Mbps cada um recebe
 * 200 kbps: a escada está certa e a imagem não existe. O que faltava era a
 * porta: parar de ADMITIR quando a próxima pessoa levaria todo mundo abaixo
 * do piso. Quem já está nunca sai (R5 continua coletiva); só a próxima recebe
 * `CHANNEL_FULL`, e tenta de novo sozinha.
 *
 * # A álgebra
 *
 * Com N caminhos medidos e um orçamento `b` por caminho, o upload útil é
 * `b·N`. Admitir mais um dá `b·N/(N+1)` a cada um; cabe enquanto isso fica no
 * piso do menor degrau, `p`:
 *
 *     b·N/(N+1) ≥ p   ⟺   ⌊b·N/p⌋ ≥ N+1
 *
 * Logo a capacidade é `⌊b·N/p⌋`, nunca abaixo de N (ninguém é expulso) nem
 * acima do que a máquina codifica.
 *
 * # Por que não é só `b` (ADR 0018, de novo)
 *
 * `b` vale `0,75 × estimativa`, e a estimativa é tampada em `1,5 × acked`
 * pelo libwebrtc. Quando somos NÓS o limitador — o caso de todo link com
 * sobra — `b ≈ 1,125 × o que enviamos`, e `b·N` passa do upload útil em 1,5×:
 * um link de 20 Mbps com um espectador a 16 Mbps "cabia" 8 pessoas no piso, e
 * 8 × 2,06 = 16,5 Mbps é mais do que os 15 Mbps úteis. A medição não fala do
 * link; fala da nossa atuação.
 *
 * O que fala do link em QUALQUER regime é o que de fato sai dele: `enviado`.
 * Sem sobreuso, o link carrega pelo menos `N × enviado`; com sobreuso,
 * `enviado` É a fatia que o link dá. Em ambos, `UPLINK_SHARE × enviado` por
 * caminho é um limite inferior honesto do útil. E `b` continua valendo onde é
 * menor — o link saturado, em que a estimativa recua abaixo da fatia. O menor
 * dos dois nunca passa da realidade, e é medido NESTE segundo: uma leva de
 * entrantes que faz `N` saltar não multiplica um `b` velho por um `N` novo.
 *
 * # Folga, histerese e cena parada
 *
 * `FOLGA_DE_ADMISSAO`: o AIMD trabalha entre 0,85 e 1,0 da fatia depois de um
 * recuo, então admitir até o piso exato deixaria o fundo da escada abaixo do
 * piso a cada recuo. Uma vaga só abre se o orçamento de todos continuar 10 %
 * acima do piso com ela.
 *
 * `FOLGA_DE_DESCIDA`: `⌊·⌋` numa fronteira inteira abriria e fecharia uma vaga
 * por um fio de ruído. Fechar exige meia vaga de orçamento faltando; abrir
 * exige a vaga inteira.
 *
 * Cena parada derruba `enviado` sem o link ter mudado (a mesma guarda do
 * governador): aí o teto não desce. Subir continua permitido, porque leitura
 * alta é verdadeira em qualquer regime.
 */
export type EntradaDeCapacidade = {
  /** Orçamento POR caminho em vigor (vídeo + áudio). `null` sem medição. */
  readonly orcamento: number | null;
  /** O que sai do link POR caminho agora, em bits/s — medido, não pedido. */
  readonly enviadoPorCaminho: number;
  /** Caminhos que entraram na medição (pares ICE nominados). */
  readonly caminhos: number;
  /** O encoder está mandando bem menos que o orçamento: cena parada. */
  readonly encoderOcioso: boolean;
  readonly reservaAudio: number;
  readonly prioridade: Prioridade;
  /** O que a máquina codifica: teto absoluto, declarado no `host`. */
  readonly capacidadeDaMaquina: number;
  /** O teto em vigor — a histerese é contra ele. */
  readonly atual: number;
};

/**
 * Até a primeira medição, o teto é o que o produto sempre prometeu antes da
 * ADR 0029. Com 50 vagas abertas antes de medir, 50 amigos clicando juntos
 * entrariam todos num link que paga 3 — e aí ninguém mais sai. Cada medição
 * abre vagas a partir daqui; num link farto são duas rodadas até o teto.
 */
export const CAPACIDADE_ATE_MEDIR: number = P2P_LIMITS.maxViewersSemUmEncode;

/** Uma vaga só abre se o orçamento de todos continuar este tanto acima do piso. */
export const FOLGA_DE_ADMISSAO = 0.1;
/** Fechar uma vaga exige meia vaga de orçamento faltando. */
export const FOLGA_DE_DESCIDA = 0.5;

/** O menor degrau da escada, no framerate da prioridade, mais o áudio. */
export function pisoPorEspectador(prioridade: Prioridade, reservaAudio: number): number {
  const fundo = presetById(PRESET_IDS[PRESET_IDS.length - 1] ?? 'p360p60');
  const fps = Math.min(fundo.main.maxFramerate, FRAMERATE_POR_PRIORIDADE[prioridade]);
  return pisoDeBitrate(fundo.width, fundo.height, fps) + reservaAudio;
}

export function capacidadePelaBanda(e: EntradaDeCapacidade): number {
  const maquina = Math.max(1, Math.floor(e.capacidadeDaMaquina));
  const chao = Math.max(1, e.caminhos);
  const limitar = (n: number): number => Math.min(maquina, Math.max(chao, Math.floor(n)));

  // Sem medição não há evidência para abrir nem fechar: fica como está.
  if (e.orcamento === null || e.caminhos <= 0 || !(e.enviadoPorCaminho > 0)) return limitar(e.atual);

  const porCaminho = Math.min(e.orcamento, UPLINK_SHARE * e.enviadoPorCaminho);
  const piso = pisoPorEspectador(e.prioridade, e.reservaAudio) * (1 + FOLGA_DE_ADMISSAO);
  const cabem = (porCaminho * e.caminhos) / piso;

  if (cabem >= e.atual + 1) return limitar(cabem);
  if (cabem < e.atual - FOLGA_DE_DESCIDA && !e.encoderOcioso) return limitar(cabem);
  return limitar(e.atual);
}
