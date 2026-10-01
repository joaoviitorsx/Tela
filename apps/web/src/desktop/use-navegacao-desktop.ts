import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { parseRoute } from '../router.js';
import type { ItemDoTrilho } from './TrilhoDesktop.js';

/**
 * A navegação da moldura do app (PLANO-desktop §11).
 *
 * O roteador da web (`router.ts`) decide a tela pelo `pathname` e ouve
 * `popstate`. A moldura só precisa de duas coisas em cima disso: saber o
 * caminho atual, para acender o item certo do trilho, e trocá-lo — pelo mesmo
 * `pushState` + `popstate` que o roteador já entende.
 *
 * # A trava
 *
 * Em `/transmitir` a rota `Broadcast` é dona da `BroadcastSession`: sair dela
 * desmonta a rota e derruba a transmissão. Na web isso é um clique perdido na
 * marca, e por isso a marca deixa de ser link ao vivo. No app o trilho fica
 * sempre à vista, então ele TRAVA enquanto a rota for a transmissão — e a
 * trava é a mesma para o trilho e para qualquer `<a>` interno.
 */
export function trilhoTravado(pathname: string): boolean {
  return parseRoute(pathname).name === 'broadcast';
}

export function itemAtivo(pathname: string): ItemDoTrilho | null {
  switch (parseRoute(pathname).name) {
    case 'home':
    case 'broadcast':
      return 'transmitir';
    case 'recover':
      return 'canal';
    default:
      return null;
  }
}

export const DESTINO: Record<ItemDoTrilho, string> = {
  transmitir: '/',
  canal: '/recuperar',
};

/**
 * O caminho interno de um link, ou `null` se ele sai do app.
 *
 * As telas do site têm `<a href="/">` e `<a href="/recuperar">`, que no
 * navegador recarregam a página. No app a navegação de página é negada pelo
 * processo principal (§3.4), então o clique vira troca de rota.
 */
export function caminhoInterno(href: string, origem: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origem);
  } catch {
    return null;
  }
  if (url.origin !== origem) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

const lerCaminho = (): string => window.location.pathname;
const assinarCaminho = (ouvinte: () => void): (() => void) => {
  window.addEventListener('popstate', ouvinte);
  return () => window.removeEventListener('popstate', ouvinte);
};

export function useNavegacaoDesktop(): {
  readonly caminho: string;
  readonly travado: boolean;
  readonly irPara: (caminho: string) => void;
} {
  const caminho = useSyncExternalStore(assinarCaminho, lerCaminho);

  const irPara = useCallback((destino: string) => {
    // Lê o caminho vivo, não o do render: a trava não pode depender de o
    // React já ter repintado o trilho.
    const atual = window.location.pathname;
    if (trilhoTravado(atual) || destino === atual) return;
    window.history.pushState({}, '', destino);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  useEffect(() => {
    const aoClicar = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const alvo = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(alvo instanceof HTMLAnchorElement) || alvo.hasAttribute('download') || alvo.target === '_blank') return;
      const destino = caminhoInterno(alvo.href, window.location.origin);
      if (destino === null) return;
      e.preventDefault();
      irPara(destino);
    };
    document.addEventListener('click', aoClicar);
    return () => document.removeEventListener('click', aoClicar);
  }, [irPara]);

  return { caminho, travado: trilhoTravado(caminho), irPara };
}
