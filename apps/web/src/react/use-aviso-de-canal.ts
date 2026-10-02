import { useEffect, useRef, useState } from 'react';
import {
  type FaseDoCanal,
  REGISTRO_INICIAL,
  type RegistroDoCanal,
  deveBipar,
  proximoRegistro,
  tituloDaAba,
} from '../core/media/aviso-de-canal.js';
import type { ViewerState } from '../core/media/viewer-session.js';
import { useTabTitle } from './use-page-effects.js';

/** Quadrado de pixel, no tom de cada fase: o que o olho vê na aba de relance. */
const CORES: Record<FaseDoCanal, { readonly preenchido: boolean; readonly cor: string }> = {
  'ao-vivo': { preenchido: true, cor: '#ff6a52' },
  esperando: { preenchido: false, cor: '#f2a93b' },
  encerrada: { preenchido: true, cor: '#8a8272' },
};

export function iconeDaFase(fase: FaseDoCanal): string {
  const { preenchido, cor } = CORES[fase];
  const miolo = preenchido
    ? `<rect x='6' y='6' width='20' height='20' fill='${cor}'/>`
    : `<rect x='7' y='7' width='18' height='18' fill='none' stroke='${cor}' stroke-width='4'/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' shape-rendering='crispEdges'><rect width='32' height='32' fill='#0b0c0e'/>${miolo}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Sem gesto na página o navegador não deixa tocar; não vale tentar. */
function podeTocar(): boolean {
  const ativacao = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } })
    .userActivation;
  return ativacao?.hasBeenActive === true;
}

/**
 * O que a aba diz de relance a quem espera o canal entrar no ar (V-03, V-04):
 * título, favicon e, quando a imagem acaba de chegar numa aba escondida, um
 * bipe curto. Sem notificação do sistema: não é rede social (R6).
 *
 * Devolve o registro, para a tela distinguir "ainda não começou" de "acabou".
 */
export function useAvisoDeCanal(
  slug: string,
  status: ViewerState['status'],
  temImagem: boolean,
  bipe: () => void,
): RegistroDoCanal {
  const [registro, setRegistro] = useState<RegistroDoCanal>(REGISTRO_INICIAL);
  // Derivado durante a render, e não em efeito: um efeito mostraria um quadro
  // de "aguardando sinal" antes de trocar para "encerrada".
  const proximo = proximoRegistro(registro, status, temImagem, Date.now());
  if (proximo !== registro) setRegistro(proximo);

  const fase = proximo.fase;
  useTabTitle(tituloDaAba(slug, fase));

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (link === null) return;
    const original = link.getAttribute('href');
    const tipo = link.type;
    link.type = 'image/svg+xml';
    link.href = iconeDaFase(fase);
    return () => {
      if (original === null) link.removeAttribute('href');
      else link.setAttribute('href', original);
      link.type = tipo;
    };
  }, [fase]);

  const anterior = useRef<FaseDoCanal>(fase);
  useEffect(() => {
    const antes = anterior.current;
    anterior.current = fase;
    if (!deveBipar(antes, fase)) return;
    // Com a aba à vista a imagem já avisa sozinha; o som é para quem está em outra.
    if (document.visibilityState === 'hidden' && podeTocar()) bipe();
  }, [fase, bipe]);

  return proximo;
}
