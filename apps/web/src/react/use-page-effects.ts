import { useEffect } from 'react';

/**
 * Detalhes pequenos que separam "funciona" de "dá pra usar por três horas".
 * Ficam num arquivo só porque todos são o mesmo tipo de coisa: efeito de
 * página, sem regra de negócio.
 */

/** Achar a aba entre trinta outras. O ponto vermelho é o que o olho procura. */
export function useTabTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** Impede a tela de apagar durante a transmissão. Falha em silêncio onde não existe. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        // Bateria fraca ou aba em segundo plano: o browser recusa. Sem drama.
      }
    };

    void acquire();
    // O browser solta o lock sozinho quando a aba perde o foco; ao voltar,
    // é preciso pedir de novo ou a tela apaga no meio do jogo.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !released) void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [active]);
}

/** Encerra a sala na hora quando o usuário só fecha a aba. */
export function useBeforeUnload(active: boolean, onUnload: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = () => onUnload();
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [active, onUnload]);
}

const ALVOS_COM_TECLA_PROPRIA = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY']);
const PAPEIS_COM_TECLA_PROPRIA = new Set([
  'slider',
  'radio',
  'button',
  'link',
  'checkbox',
  'switch',
  'menuitem',
  'tab',
  'textbox',
  'spinbutton',
]);

/**
 * O foco está num controle que já usa a tecla? Botão usa Enter e Espaço,
 * slider usa as setas, campo usa tudo. Interceptar aqui é falha de WCAG 2.1.1
 * e 4.1.2: o atalho de página tem de ceder ao controle focado.
 */
export function alvoTemTeclaPropria(alvo: EventTarget | null): boolean {
  if (alvo === null || !('tagName' in alvo)) return false;
  const el = alvo as HTMLElement;
  if (ALVOS_COM_TECLA_PROPRIA.has(el.tagName) || el.isContentEditable) return true;
  const papel = el.getAttribute?.('role');
  return papel !== null && papel !== undefined && PAPEIS_COM_TECLA_PROPRIA.has(papel);
}

/**
 * Atalhos de teclado de página. Não agem com Ctrl, Alt ou Meta (são do
 * navegador) nem quando o foco está num controle que usa a tecla (ver
 * `alvoTemTeclaPropria`).
 */
export function useHotkeys(map: Record<string, () => void>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (alvoTemTeclaPropria(event.target)) return;
      const action = map[event.key.toLowerCase()];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [map, enabled]);
}
