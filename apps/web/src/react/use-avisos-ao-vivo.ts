import { PRESETS, type PresetId } from '@tela/shared';
import { useMemo } from 'react';
import type { EstadoAudio } from '../core/media/audio-state.js';
import type { BroadcastState } from '../core/media/broadcast-session.js';

type EstadoAoVivo = Extract<BroadcastState, { status: 'live' }>;

export type AvisoAoVivo = { readonly chave: string; readonly texto: string };

const rotuloDoDegrau = (id: PresetId): string => PRESETS[id].label.replace(' econômico', ' eco');

/**
 * Só os estados do som que pedem ação de quem transmite.
 *
 * `mudo` foi escolha dele, `sem-fonte` já tem aviso próprio quando custou o
 * áudio (`audioPerdidoPelaEscolha`), e perda é medida do lado de quem recebe.
 * Trocar a fonte NÃO recaptura o som — a troca preserva a trilha de áudio de
 * propósito —, então o texto não pode sugerir isso.
 */
const AVISO_AUDIO: Partial<Record<EstadoAudio, string>> = {
  bloqueado:
    'O navegador pausou o áudio da transmissão: os amigos estão ouvindo silêncio. Use "ativar áudio da transmissão" no painel.',
  encerrada:
    'O som da captura acabou: os amigos estão sem áudio. Pare e comece de novo para capturá-lo outra vez.',
  'sem-sinal':
    'Nenhum som saindo há 20 segundos. Se o jogo está tocando, confira a fonte de áudio escolhida.',
};

/**
 * Todos os alertas num lugar só, na ordem em que doem: sem imagem (ninguém
 * está vendo nada), sem servidor (ninguém novo entra), sem áudio, qualidade
 * reduzida, e o diagnóstico do momento.
 *
 * O motivo da degradação muda o que a pessoa faz. `cpu` quase sempre é encode
 * em SOFTWARE, o caso que rouba quadros do jogo e que tem conserto do lado de
 * quem transmite; `bandwidth` é o link, e não adianta mexer na máquina.
 *
 * `avisoMomentaneo` é o `qualityLimitationReason` do instante, e some quando
 * `presetForced` já explica a mesma coisa com mais detalhe: os dois juntos
 * seriam o mesmo aviso duas vezes, em tons diferentes.
 */
export function montarAvisos(estado: EstadoAoVivo, avisoMomentaneo: string | null): AvisoAoVivo[] {
  const avisos: (AvisoAoVivo | false)[] = [
    estado.capturaSemImagem && {
      chave: 'sem-sinal',
      texto:
        'A captura não está produzindo imagem: os amigos estão vendo preto. Pare e escolha a tela de novo.',
    },
    estado.semSinalizacao && {
      chave: 'sem-sinalizacao',
      texto:
        'Servidor fora do ar. Quem já está assistindo continua vendo, mas ninguém novo consegue entrar pelo link.',
    },
    estado.peers.some((p) => p.connectionState === 'disconnected') && {
      chave: 'reconectando',
      texto: 'Um espectador perdeu a conexão e está reconectando.',
    },
    estado.audioPerdidoPelaEscolha && {
      chave: 'sem-audio',
      texto:
        'Sem áudio: o som do sistema só acompanha a tela inteira. Pare e escolha "Tela inteira" no seletor.',
    },
    AVISO_AUDIO[estado.audio] !== undefined && {
      chave: 'audio',
      texto: AVISO_AUDIO[estado.audio] as string,
    },
    estado.presetForced && {
      chave: 'degradado',
      // Diz PARA O QUÊ e por quê (C-06): a resposta não fica duas camadas abaixo, no diagnóstico.
      texto:
        estado.motivoDegradacao === 'cpu'
          ? `Sua máquina não sustenta ${rotuloDoDegrau(estado.presetEscolhido)}: enviando ${rotuloDoDegrau(estado.presetId)}. Confira se a aceleração por hardware está ligada em chrome://gpu; em software, o jogo perde quadros.`
          : estado.motivoDegradacao === 'bandwidth'
            ? `Seu upload não sustenta ${rotuloDoDegrau(estado.presetEscolhido)}: enviando ${rotuloDoDegrau(estado.presetId)}. Volta sozinho quando a rede sobrar.`
            : `Qualidade reduzida: enviando ${rotuloDoDegrau(estado.presetId)}. Volta sozinha quando der.`,
    },
    !estado.presetForced &&
      avisoMomentaneo !== null && {
        chave: 'aviso',
        // Diz o que está saindo agora (C-06), não só que algo aperta.
        texto:
          estado.stats !== null && estado.stats.width > 0
            ? `${avisoMomentaneo}: enviando ${estado.stats.width}×${estado.stats.height}. Volta sozinho quando der.`
            : avisoMomentaneo,
      },
  ];
  return avisos.filter((a): a is AvisoAoVivo => a !== false);
}

export function useAvisosAoVivo(
  estado: EstadoAoVivo | null,
  avisoMomentaneo: string | null,
): readonly AvisoAoVivo[] {
  return useMemo(
    () => (estado === null ? [] : montarAvisos(estado, avisoMomentaneo)),
    [estado, avisoMomentaneo],
  );
}
