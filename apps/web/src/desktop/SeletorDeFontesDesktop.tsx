import { SeletorDeFontes } from '../components/SeletorDeFontes.js';
import type { PlataformaDesktop } from './ponte.js';
import type { SeletorDeFontes as LojaDoSeletor } from './seletor-de-fontes.js';
import { useSeletorDeFontes } from './use-seletor-de-fontes.js';

type Props = {
  readonly seletor: LojaDoSeletor;
  readonly plataforma: PlataformaDesktop;
};

/**
 * O seletor de fontes montado na moldura do app: fica sempre na árvore (o
 * `<dialog>` fechado não desenha nada) e abre quando o adapter de captura
 * pede. A loja decide; o componente desenha.
 */
export function SeletorDeFontesDesktop({ seletor, plataforma }: Props) {
  const { estado, dialogo, avisoDeJanela, avisoDoJogo } = useSeletorDeFontes(seletor, plataforma);
  return (
    <SeletorDeFontes
      dialogRef={dialogo.ref}
      aoClicarNoFundo={dialogo.aoClicar}
      aba={estado.aba}
      fontes={estado.fontes}
      carregando={estado.carregando}
      avisoDeJanela={avisoDeJanela}
      avisoDoJogo={avisoDoJogo}
      aoMudarAba={seletor.mudarAba}
      aoEscolher={seletor.escolher}
      aoCancelar={seletor.cancelar}
    />
  );
}
