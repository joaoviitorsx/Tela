import { IconWarning } from './Icon.js';

type Props = {
  readonly resolution: string;
  readonly fps: string;
  readonly bitrate: string;
  readonly rtt: string;
  readonly warning: string | null;
};

/**
 * Diagnóstico honesto em vez de número bonito.
 *
 * Quando o WebRTC diz `qualityLimitationReason: 'cpu'`, o usuário lê "CPU no
 * limite" — não "conexão instável". O público-alvo é gamer: ele entende, e
 * mentir para ele só adia o problema.
 */
export function StatsBadge({ resolution, fps, bitrate, rtt, warning }: Props) {
  if (warning !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-warn">
        <IconWarning className="h-3.5 w-3.5" />
        {warning}
      </span>
    );
  }

  return (
    <span className="tabular inline-flex items-center gap-2 text-[12px] text-muted">
      <span>{resolution}</span>
      <Separator />
      <span>{fps}</span>
      <Separator />
      <span>{bitrate}</span>
      <Separator />
      <span>{rtt}</span>
    </span>
  );
}

function Separator() {
  return (
    <span className="text-faint" aria-hidden="true">
      ·
    </span>
  );
}
