import { useMemo, useSyncExternalStore } from 'react';
import { type Dialogo, useDialogo } from '../react/use-dialogo.js';
import { avisoDeCursor } from './aviso-de-cursor.js';
import type { PlataformaDesktop } from './ponte.js';
import type { EstadoDoSeletor, SeletorDeFontes } from './seletor-de-fontes.js';

/**
 * A ponte React do seletor de fontes: assina a loja (`seletor-de-fontes.ts`)
 * por `useSyncExternalStore` — a loja já é a fonte da verdade, e quem a abre
 * é o adapter de captura, fora da árvore — e liga o `<dialog>` ao `aberto`.
 */
export function useSeletorDeFontes(
  seletor: SeletorDeFontes,
  plataforma: PlataformaDesktop,
): {
  readonly estado: EstadoDoSeletor;
  readonly dialogo: Dialogo;
  readonly avisoDeJanela: string | null;
  readonly avisoDoJogo: string | null;
} {
  const estado = useSyncExternalStore(seletor.assinar, seletor.snapshot, seletor.snapshot);
  const dialogo = useDialogo(estado.aberto, seletor.cancelar);
  // Só quando a listagem muda (a cada 2 s, com o seletor aberto).
  const avisoDoJogo = useMemo(() => avisoDeCursor(estado.fontes, plataforma), [estado.fontes, plataforma]);
  return { estado, dialogo, avisoDeJanela: avisoDeJanela(plataforma), avisoDoJogo };
}

/**
 * No Windows o som do sistema só acompanha a TELA INTEIRA (`screen-capture.ts`,
 * `CaptureSurface`). Dizer antes de escolher poupa a transmissão muda.
 */
export function avisoDeJanela(plataforma: PlataformaDesktop): string | null {
  return plataforma === 'win32' ? 'No Windows, transmitir uma janela não leva o som do sistema. Para ter som com a janela, escolha “Só o jogo” no passo ÁUDIO; ou escolha a TELA.' : null;
}
