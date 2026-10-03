import { ConteudoDiscord } from '../components/ConteudoDiscord.js';
import { Dialogo } from '../components/Dialogo.js';
import { useCopia } from '../react/use-copia.js';
import { useDialogo } from '../react/use-dialogo.js';

type Props = {
  readonly aberto: boolean;
  readonly aoFechar: () => void;
  readonly urlInstalar: string;
  readonly canal: string;
};

/** "TELA NO DISCORD": instalar o app e o `/tela` com o nome do canal pronto. */
export function ModalDiscord({ aberto, aoFechar, urlInstalar, canal }: Props) {
  const dialogo = useDialogo(aberto, aoFechar);
  const copia = useCopia(1_500);
  return (
    <Dialogo titulo="TELA NO DISCORD" dialogRef={dialogo.ref} aoClicar={dialogo.aoClicar} aoFechar={aoFechar} estreito>
      <ConteudoDiscord
        urlInstalar={urlInstalar}
        canal={canal}
        copiado={copia.copiado}
        aoCopiar={() => copia.copiar(canal)}
      />
    </Dialogo>
  );
}
