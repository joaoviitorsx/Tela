import { useCallback, useEffect, useState } from 'react';
import { canaisDoSegmento } from './core/domain/canais-da-rota.js';

/**
 * Roteador de 40 linhas.
 *
 * O produto tem quatro telas e nenhuma rota aninhada. `react-router` traria
 * ~20KB e uma API inteira para resolver um problema que `history.pushState` +
 * `popstate` resolvem — e AGENTS.md pede justificativa para toda dependência
 * nova. Não há justificativa aqui.
 */
export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'recover' }
  | { readonly name: 'broadcast' }
  /**
   * `canais`: um, ou dois na multivisão (`/a+b`, ADR 0032). `slug` é o
   * primeiro — a principal quando a página abre.
   */
  | { readonly name: 'viewer'; readonly slug: string; readonly canais: readonly string[] }
  | { readonly name: 'not-found' };

export function parseRoute(pathname: string): Route {
  const segment = pathname.replace(/^\/+|\/+$/g, '');
  if (segment === '') return { name: 'home' };
  if (segment === 'recuperar') return { name: 'recover' };
  if (segment === 'transmitir') return { name: 'broadcast' };
  const canais = canaisDoSegmento(segment);
  const slug = canais?.[0];
  if (canais !== null && slug !== undefined) return { name: 'viewer', slug, canais };
  return { name: 'not-found' };
}

export function useRoute(): { route: Route; navigate: (path: string) => void } {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    // Um evento só para toda troca de rota: quem mais observa o caminho (a
    // moldura do app desktop) ouve o mesmo `popstate` do botão voltar, e o
    // `setRoute` acontece no ouvinte acima, igual.
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  return { route, navigate };
}
