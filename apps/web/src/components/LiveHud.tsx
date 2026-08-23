import type { EncodingPreset, PresetId } from '@tela/shared';
import { IconCheck, IconCopy, IconStop, IconViewers } from './Icon.js';
import { LiveDot } from './LiveDot.js';
import { QualityPicker } from './QualityPicker.js';
import { StatsBadge } from './StatsBadge.js';

type Props = {
  readonly shareUrl: string;
  readonly viewers: number;
  /** Teto do canal. Mostrar `2/3` diz mais que `2` — o usuário sabe quanto falta. */
  readonly maxPeers: number;
  /** Quantos espectadores estão passando por TURN. */
  readonly relayed: number;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onStop: () => void;
  readonly visible: boolean;
  readonly reconnecting: boolean;
  readonly presets: readonly EncodingPreset[];
  readonly presetId: PresetId;
  readonly presetForced: boolean;
  readonly onPreset: (id: PresetId) => void;
  readonly stats: {
    readonly resolution: string;
    readonly fps: string;
    readonly bitrate: string;
    readonly rtt: string;
    readonly warning: string | null;
  };
};

/**
 * HUD no canto superior. Nunca cobre o centro.
 *
 * O link JÁ foi copiado ao iniciar — o botão existe para a segunda vez. Some
 * depois de 5s e volta no mousemove, porque o que está embaixo é o jogo.
 */
export function LiveHud({
  shareUrl,
  viewers,
  maxPeers,
  relayed,
  copied,
  onCopy,
  onStop,
  visible,
  reconnecting,
  presets,
  presetId,
  presetForced,
  onPreset,
  stats,
}: Props) {
  return (
    <div
      className={[
        'pointer-events-none fixed inset-x-0 top-0 z-20 p-3 sm:p-4',
        'transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
    >
      <div className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-2 rounded-md border border-edge bg-surface/95 p-3 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {reconnecting ? <LiveDot label="RECONECTANDO" tone="warn" /> : <LiveDot />}

          <button
            type="button"
            onClick={onCopy}
            className="tabular group inline-flex min-h-8 items-center gap-2 rounded-sm px-2 text-[13px] text-text transition-colors duration-150 hover:bg-void"
          >
            {shareUrl.replace(/^https?:\/\//, '')}
            {copied ? (
              <IconCheck className="h-3.5 w-3.5 text-text" />
            ) : (
              <IconCopy className="h-3.5 w-3.5 text-muted group-hover:text-text" />
            )}
            <span className="sr-only">{copied ? 'link copiado' : 'copiar link'}</span>
          </button>

          <span className="tabular inline-flex items-center gap-1.5 text-[13px] text-muted">
            <IconViewers className="h-4 w-4" />
            {viewers}/{maxPeers}
            <span className="sr-only">
              {viewers === 1 ? 'espectador' : 'espectadores'} de {maxPeers}
            </span>
          </span>

          {relayed > 0 && (
            <span
              className="tabular text-[12px] text-warn"
              title="Conexão indireta, via servidor de relay: latência maior e cota consumida."
            >
              {relayed} via relay
            </span>
          )}

          <span className="ml-auto flex items-center gap-3">
            <StatsBadge {...stats} />
            <button
              type="button"
              onClick={onStop}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-edge px-2.5 text-[13px] text-muted transition-colors duration-150 hover:border-danger hover:text-danger"
            >
              <IconStop className="h-3 w-3" />
              parar
            </button>
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
          <QualityPicker
            presets={presets}
            value={presetId}
            onChange={onPreset}
            compact
          />
          <span className="text-[12px] text-muted">
            direto do seu PC — fechar esta aba encerra a transmissão
          </span>
        </div>

        {presetForced && (
          <p role="status" className="text-[12px] text-warn">
            Qualidade reduzida automaticamente — o encoder não estava dando conta.
          </p>
        )}
      </div>
    </div>
  );
}
