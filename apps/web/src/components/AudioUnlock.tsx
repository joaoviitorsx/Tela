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
      className="animate-enter absolute inset-0 z-30 flex cursor-pointer items-center justify-center bg-void/55 backdrop-blur-[2px]"
    >
      <span className="flex items-center gap-3 rounded-md border border-line bg-surface px-6 py-4 text-[15px] font-medium">
        <IconMuted className="h-5 w-5 text-accent" />
        Clique para ativar o som
      </span>
    </button>
  );
}
