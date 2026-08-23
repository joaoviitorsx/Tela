import { useEffect, useState } from 'react';
import type { AppErrorCode } from '@tela/shared';
import { api } from '../container.js';

export type SlugCheck =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'invalid'; reason: AppErrorCode }
  | { status: 'free' }
  | { status: 'live' };

/**
 * Disponibilidade do slug enquanto o usuário digita, com debounce de 300ms.
 *
 * Usa `GET /live/:slug`, que responde `{live:false}` tanto para "não existe"
 * quanto para "existe e está offline" — de propósito (§15). Portanto isto
 * indica "alguém está transmitindo agora", não "o nome está livre". A
 * confirmação real de disponibilidade só vem do 201/409 do claim.
 */
export function useSlugCheck(raw: string): SlugCheck {
  const [check, setCheck] = useState<SlugCheck>({ status: 'idle' });

  useEffect(() => {
    const slug = raw.trim().toLowerCase();
    if (slug.length === 0) {
      setCheck({ status: 'idle' });
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,23}[a-z0-9]$/.test(slug)) {
      setCheck({ status: 'invalid', reason: 'SLUG_INVALID' });
      return;
    }

    setCheck({ status: 'checking' });
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await api.liveStatus(slug);
      if (cancelled) return;
      setCheck(result.ok && result.value.live ? { status: 'live' } : { status: 'free' });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [raw]);

  return check;
}
