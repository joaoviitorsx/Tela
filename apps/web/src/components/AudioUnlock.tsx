import { IconMuted } from './Icon.js';

type Props = { readonly onUnlock: () => void };

/**
 * Autoplay com som é bloqueado por política de browser. Isso não é bug, é
 * regra — então o overlay é grande, claro e some no primeiro clique em
 * QUALQUER ponto da tela, não só no botão.
 */
export function AudioUnlock({ onUnlock }: Props) {
  return (
    <button
      type="button"
      onClick={onUnlock}
      aria-label="Ativar o som"
      /*
        Sem `backdrop-blur`: ele custa um desfoque da viewport inteira POR
        FRAME, sobre vídeo ao vivo, e este overlay aparece por padrão em toda
        visita com áudio. Escurecer mais resolve o mesmo problema de contraste
        de graça.
      */
      className="animate-enter absolute inset-0 z-30 flex cursor-pointer items-center justify-center bg-void/70"
    >
      <span className="flex items-center gap-3 rounded-md border border-edge bg-surface px-6 py-4 text-[15px] font-medium">
        <IconMuted className="h-5 w-5 text-text" />
        Clique para ativar o som
      </span>
    </button>
  );
}
