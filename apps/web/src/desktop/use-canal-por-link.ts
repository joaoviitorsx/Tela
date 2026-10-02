import { useCallback, useEffect, useRef, useState } from 'react';
import { canalDaEntrada } from '../core/domain/entrada-de-canal.js';
import type { PonteDesktop } from './ponte.js';
import { trilhoTravado } from './use-navegacao-desktop.js';

export const AVISO_AO_VIVO = 'Você está ao vivo — abra o canal depois de encerrar a transmissão.';

/** Quanto o aviso fica na tela. Ele não bloqueia nada; some sozinho. */
const DURACAO_DO_AVISO_MS = 8_000;

/**
 * `tela://assistir/<canal>`: o main entrega o slug e a PÁGINA decide.
 *
 * - Revalida o slug (a ponte é a fronteira de confiança, não o payload).
 * - Ao vivo (`/transmitir`) NÃO navega: sair da rota derrubaria a transmissão
 *   por causa de um clique de outra pessoa num link. Mostra um aviso que não
 *   bloqueia e some sozinho.
 * - Um link nunca inicia captura nem transmissão; só leva à rota do espectador.
 */
export function useCanalPorLink(
  ponte: Pick<PonteDesktop, 'aoAbrirCanal'> | undefined,
  irPara: (caminho: string) => void,
): { readonly aviso: string | null; readonly dispensar: () => void } {
  const [aviso, setAviso] = useState<string | null>(null);
  const relogio = useRef<ReturnType<typeof setTimeout> | null>(null);
  const irParaRef = useRef(irPara);
  irParaRef.current = irPara;

  const dispensar = useCallback(() => {
    if (relogio.current !== null) clearTimeout(relogio.current);
    relogio.current = null;
    setAviso(null);
  }, []);

  useEffect(() => {
    if (ponte === undefined) return;
    const cancelar = ponte.aoAbrirCanal((slug) => {
      const canal = canalDaEntrada(slug);
      if (!canal.ok || canal.value !== slug) return;
      // Lê o caminho vivo: é ele que diz se há transmissão, não o último render.
      if (trilhoTravado(window.location.pathname)) {
        setAviso(AVISO_AO_VIVO);
        if (relogio.current !== null) clearTimeout(relogio.current);
        relogio.current = setTimeout(() => {
          relogio.current = null;
          setAviso(null);
        }, DURACAO_DO_AVISO_MS);
        return;
      }
      irParaRef.current(`/${canal.value}`);
    });
    return () => {
      cancelar();
      if (relogio.current !== null) clearTimeout(relogio.current);
      relogio.current = null;
    };
  }, [ponte]);

  return { aviso, dispensar };
}
