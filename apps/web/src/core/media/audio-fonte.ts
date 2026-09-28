import type { CaptureSurface } from '../ports/screen-capture.js';

/**
 * De onde veio o som, e o que o navegador de fato aplicou nele (§6.3).
 *
 * Pedir `echoCancellation: false` não prova que ele saiu desligado: a
 * constraint é pedido. `getSettings()` é o que o navegador diz ter feito, e
 * campo ausente ali significa DESCONHECIDO — não "desligado".
 */
export type TipoFonteAudio =
  /** Tela inteira com áudio do sistema (Windows/Chrome). */
  | 'sistema'
  | 'janela'
  | 'aba'
  /** Dispositivo escolhido na lista — monitor de sink virtual no Linux, ou microfone. */
  | 'dispositivo'
  | 'desconhecida'
  | 'nenhuma';

export type CapturaAudio = {
  readonly fonte: TipoFonteAudio;
  readonly echoCancellation: boolean | null;
  readonly noiseSuppression: boolean | null;
  readonly autoGainControl: boolean | null;
  readonly canais: number | null;
  readonly sampleRate: number | null;
};

export function fonteDaSuperficie(surface: CaptureSurface): TipoFonteAudio {
  switch (surface) {
    case 'monitor':
      return 'sistema';
    case 'window':
      return 'janela';
    case 'browser':
      return 'aba';
    default:
      return 'desconhecida';
  }
}

function booleano(valor: unknown): boolean | null {
  return typeof valor === 'boolean' ? valor : null;
}

function inteiro(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

export function descreverCaptura(
  track: MediaStreamTrack | null,
  fonte: TipoFonteAudio,
): CapturaAudio {
  if (track === null) {
    return {
      fonte: 'nenhuma', echoCancellation: null, noiseSuppression: null,
      autoGainControl: null, canais: null, sampleRate: null,
    };
  }
  let s: Record<string, unknown> = {};
  try {
    s = track.getSettings() as Record<string, unknown>;
  } catch {
    // Sem leitura, tudo fica desconhecido.
  }
  return {
    fonte,
    echoCancellation: booleano(s['echoCancellation']),
    noiseSuppression: booleano(s['noiseSuppression']),
    autoGainControl: booleano(s['autoGainControl']),
    canais: inteiro(s['channelCount']),
    sampleRate: inteiro(s['sampleRate']),
  };
}
