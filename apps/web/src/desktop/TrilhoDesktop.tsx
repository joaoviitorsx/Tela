import { IconChave, IconTv } from '../components/Icon.js';

export type ItemDoTrilho = 'transmitir' | 'canal';

type Props = {
  readonly ativo: ItemDoTrilho | null;
  /** Ao vivo: nenhum item responde. Sair da rota derrubaria a transmissão. */
  readonly travado: boolean;
  readonly aoEscolher: (item: ItemDoTrilho) => void;
};

const ITENS: ReadonlyArray<{
  readonly id: ItemDoTrilho;
  readonly rotulo: string;
  readonly Icone: typeof IconTv;
}> = [
  { id: 'transmitir', rotulo: 'TRANSMITIR', Icone: IconTv },
  { id: 'canal', rotulo: 'CANAL', Icone: IconChave },
];

/**
 * O trilho fino à esquerda, à moda do Discord — com a tecla do site.
 *
 * Só desenho: quem sabe o caminho e a trava é `useNavegacaoDesktop`. Por
 * enquanto são dois itens; Sala, Diagnóstico e Ajustes chegam com o estado
 * que precisam (D2/D4), não como botão morto.
 */
export function TrilhoDesktop({ ativo, travado, aoEscolher }: Props) {
  return (
    <nav
      aria-label="Tela Desktop"
      className="flex w-[76px] shrink-0 flex-col items-center gap-2 border-r-2 border-line bg-bar px-2 py-3"
    >
      {ITENS.map(({ id, rotulo, Icone }) => {
        const atual = id === ativo;
        return (
          <button
            key={id}
            type="button"
            disabled={travado}
            aria-current={atual ? 'page' : undefined}
            title={travado ? 'Ao vivo: encerre a transmissão antes de sair daqui' : undefined}
            onClick={() => aoEscolher(id)}
            className={[
              'tecla h-[60px] w-[60px] flex-col gap-1.5 px-0 text-[9px]',
              atual ? 'tecla-primaria' : '',
            ].join(' ')}
          >
            <Icone className="h-5 w-5" />
            {rotulo}
          </button>
        );
      })}
    </nav>
  );
}
