import { IconMudo } from './Icon.js';

type Props = { readonly onUnlock: () => void };

/**
 * Autoplay com som é bloqueado por política de browser. Isso não é bug, é
 * regra — então o overlay é grande, claro e some no primeiro clique em
 * QUALQUER ponto da tela, não só na caixa.
 *
 * Sem `backdrop-blur`: ele custa um desfoque da viewport inteira POR FRAME,
 * sobre vídeo ao vivo, e este overlay aparece por padrão em toda visita com
 * áudio. Escurece 55%, e não 70% (V-09): o jogo continua legível por baixo, e
 * a caixa no centro, em fundo `void`, é que carrega o contraste.
 */
export function AudioUnlock({ onUnlock }: Props) {
  return (
    <button
      type="button"
      onClick={onUnlock}
      aria-label="Ativar o som"
      className="entra acima-do-crt absolute inset-0 z-30 flex cursor-pointer items-center justify-center border-0 bg-black/55 p-0"
    >
      <span className="flex items-center gap-3.5 border-2 border-accent bg-void px-6 py-4 font-[family-name:var(--font-pixel)] text-[14px] text-accent-hi shadow-[0_0_0_2px_#000,0_0_28px_rgb(242_169_59_/_0.3)]">
        <IconMudo className="h-5 w-5 text-accent-hi" />
        Clique para ativar o som
      </span>
    </button>
  );
}
