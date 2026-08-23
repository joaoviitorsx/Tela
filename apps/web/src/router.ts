import { useCallback, useEffect, useState } from 'react';

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
  | { readonly name: 'viewer'; readonly slug: string }
  | { readonly name: 'not-found' };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,23}[a-z0-9]$/;

export function parseRoute(pathname: string): Route {
  const segment = pathname.replace(/^\/+|\/+$/g, '');
  if (segment === '') return { name: 'home' };
  if (segment === 'recuperar') return { name: 'recover' };
  if (segment === 'transmitir') return { name: 'broadcast' };
  if (SLUG_RE.test(segment)) return { name: 'viewer', slug: segment };
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
    setRoute(parseRoute(path));
  }, []);

  return { route, navigate };
}
