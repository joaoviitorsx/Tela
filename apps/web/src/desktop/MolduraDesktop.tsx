import type { ReactNode } from 'react';
import { TrilhoDesktop } from './TrilhoDesktop.js';
import { DESTINO, itemAtivo, useNavegacaoDesktop } from './use-navegacao-desktop.js';

type Props = { readonly children: ReactNode };

/**
 * A moldura do app em volta das telas do site: trilho à esquerda, a tela à
 * direita, rolando sozinha. As rotas continuam `min-h-dvh`; aqui elas são
 * a altura da coluna, e a coluna é a janela.
 */
export function MolduraDesktop({ children }: Props) {
  const { caminho, travado, irPara } = useNavegacaoDesktop();
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-void">
      <TrilhoDesktop ativo={itemAtivo(caminho)} travado={travado} aoEscolher={(item) => irPara(DESTINO[item])} />
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
