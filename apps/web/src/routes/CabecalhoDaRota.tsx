import type { ComponentProps } from 'react';
import { Cabecalho } from '../components/Cabecalho.js';
import { dentroDoApp } from '../container.js';

/**
 * O cabeçalho do site, que no app desktop não existe (D-04): a janela já se
 * chama Tela, e o que ele oferece mora no trilho da moldura.
 */
export function CabecalhoDaRota(props: ComponentProps<typeof Cabecalho>) {
  if (dentroDoApp) return null;
  return <Cabecalho {...props} />;
}
