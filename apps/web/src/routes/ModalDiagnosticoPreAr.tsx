import { DiagnosticoPreAr } from '../components/DiagnosticoPreAr.js';
import { Dialogo } from '../components/Dialogo.js';
import { TesteDeRede } from '../components/TesteDeRede.js';
import { capacidadeDeEspectadores, pecasAusentesDoUmEncode, sondaDeRede, umEncode } from '../container-transmissao.js';
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
          /*
            O teto é deste TRANSMISSOR, não do produto. Com um encoder para
            todos (D0b) o custo por espectador é só banda; sem as peças, cada
            espectador é mais um encoder, e o número para em poucos. Dizer
            "até 50" a quem não tem como servir 50 é a mentira que esta linha
            existe para não contar.
          */
          {
            rotulo: 'CABEM',
            valor: `até ${capacidadeDeEspectadores()}`,
            nota: umEncode()
              ? 'um encoder para todos; quantos em cada qualidade depende da subida'
              : `este navegador codifica uma vez por espectador (sem ${pecasAusentesDoUmEncode().join(', ')}); o app desktop sobe o teto`,
          },
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
