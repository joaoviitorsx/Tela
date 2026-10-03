import { useMemo, useRef, useSyncExternalStore } from 'react';
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
  const calculado = useMemo(() => avisoDeCursor(estado.fontes, plataforma), [estado.fontes, plataforma]);
  /*
    Visto uma vez, fica até fechar: passados 10 s sem clique o main recusa a
    listagem (portão de gesto) e ela volta vazia — o aviso sumiria no meio da
    leitura.
  */
  const ultimo = useRef<string | null>(null);
  // `carregando` = abertura nova (a loja zera as fontes ao abrir): o aviso da anterior não vem junto,
  // mesmo quando um `abrir` por cima de outro pula o render fechado.
  if (!estado.aberto || estado.carregando) ultimo.current = null;
  else if (calculado !== null) ultimo.current = calculado;
  const avisoDoJogo = estado.aberto ? ultimo.current : null;
  return { estado, dialogo, avisoDeJanela: avisoDeJanela(plataforma), avisoDoJogo };
}

/**
 * No Windows o som do sistema só acompanha a TELA INTEIRA (`screen-capture.ts`,
 * `CaptureSurface`). Dizer antes de escolher poupa a transmissão muda.
 */
export function avisoDeJanela(plataforma: PlataformaDesktop): string | null {
  return plataforma === 'win32' ? 'No Windows, transmitir uma janela não leva o som do sistema. Para ter som com a janela, escolha “Só o jogo” no passo ÁUDIO; ou escolha a TELA.' : null;
}
