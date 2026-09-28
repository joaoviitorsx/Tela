import { P2P_LIMITS } from '@tela/shared';
import { DiagnosticoPreAr } from '../components/DiagnosticoPreAr.js';
import { Dialogo } from '../components/Dialogo.js';
import { TesteDeRede } from '../components/TesteDeRede.js';
import { sondaDeRede } from '../container.js';
import { useDialogo } from '../react/use-dialogo.js';
import { BLOCOS_DO_TESTE, medidaDaConexaoDireta, useTesteDeRede } from '../react/use-teste-de-rede.js';

type Props = { readonly aberto: boolean; readonly aoFechar: () => void };

/** "DIAGNÓSTICO ▸ REDE E CONEXÕES" antes de ir ao ar. */
export function ModalDiagnosticoPreAr({ aberto, aoFechar }: Props) {
  const dialogo = useDialogo(aberto, aoFechar);
  const teste = useTesteDeRede(sondaDeRede);
  return (
    <Dialogo titulo="DIAGNÓSTICO ▸ REDE E CONEXÕES" dialogRef={dialogo.ref} aoClicar={dialogo.aoClicar} aoFechar={aoFechar}>
      <DiagnosticoPreAr
        resumo={[
          { rotulo: 'SUA SUBIDA', valor: '— —', tom: 'destaque', nota: 'medida ao vivo, pelo próprio envio' },
          { rotulo: 'CABEM', valor: `até ${P2P_LIMITS.maxViewersBrowser}`, nota: 'quantos em cada qualidade depende da subida' },
          medidaDaConexaoDireta(teste),
          { rotulo: 'TURN', valor: 'AO TRANSMITIR', nota: 'o servidor entrega a credencial quando você vai ao ar' },
        ]}
        teste={
          <TesteDeRede
            testando={teste.fase === 'testando'}
            blocos={teste.blocos}
            total={BLOCOS_DO_TESTE}
            aoTestar={teste.testar}
          />
        }
      />
    </Dialogo>
  );
}
