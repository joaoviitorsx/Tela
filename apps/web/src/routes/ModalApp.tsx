import { ConteudoApp } from '../components/ConteudoApp.js';
import { Dialogo } from '../components/Dialogo.js';
import { MenuOsd } from '../components/MenuOsd.js';
import { useDialogo } from '../react/use-dialogo.js';
import { useMenuOsd } from '../react/use-menu-osd.js';
import { IDS_PREVIA_APP, usePreviaApp } from '../react/use-previa-app.js';

type Props = { readonly aberto: boolean; readonly aoFechar: () => void };

/** "BAIXAR ▸ APP DESKTOP": prévia do app, com downloads em breve. */
export function ModalApp({ aberto, aoFechar }: Props) {
  const dialogo = useDialogo(aberto, aoFechar);
  const previa = usePreviaApp();
  const menu = useMenuOsd({ ids: IDS_PREVIA_APP, aoAjustar: previa.ajustar });
  return (
    <Dialogo titulo="BAIXAR ▸ APP DESKTOP" dialogRef={dialogo.ref} aoClicar={dialogo.aoClicar} aoFechar={aoFechar}>
      <ConteudoApp
        posicao={menu.posicao}
        menu={
          <MenuOsd
            rotulo="Prévia das opções do app"
            linhas={previa.linhas}
            ativo={menu.ativo}
            propsContainer={menu.propsContainer}
            propsLinha={menu.propsLinha}
            aoAjustar={previa.ajustar}
            aoDefinirBarra={() => undefined}
            aoSelecionar={menu.selecionar}
          />
        }
      />
    </Dialogo>
  );
}
