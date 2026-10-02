import { IconChave, IconOlho, IconTv } from '../components/Icon.js';
import { Led } from '../components/Led.js';

export type ItemDoTrilho = 'transmitir' | 'assistir' | 'canal';

type Props = {
  readonly ativo: ItemDoTrilho | null;
  /** Ao vivo: só o item ativo responde. Sair da rota derrubaria a transmissão. */
  readonly travado: boolean;
  readonly aoEscolher: (item: ItemDoTrilho) => void;
};

const ITENS: ReadonlyArray<{
  readonly id: ItemDoTrilho;
  readonly rotulo: string;
  /** O nome por extenso, para o `title` e o leitor de tela. */
  readonly nome: string;
  readonly Icone: typeof IconTv;
}> = [
  { id: 'transmitir', rotulo: 'TRANSMITIR', nome: 'Transmitir', Icone: IconTv },
  { id: 'assistir', rotulo: 'ASSISTIR', nome: 'Assistir a um canal', Icone: IconOlho },
  // O rótulo é o da tela que abre ("CÓDIGO DO CANAL"), e a chave é a posse do canal.
  { id: 'canal', rotulo: 'CÓDIGO', nome: 'Código do canal', Icone: IconChave },
];

const ID_DICA = 'trilho-dica';

/**
 * O trilho fino à esquerda, à moda do Discord — com a tecla do site.
 *
 * Só desenho: quem sabe o caminho e a trava é `useNavegacaoDesktop`. ASSISTIR
 * (D8) não é uma rota: abre o painel onde se cola o link, e acende enquanto a
 * rota do espectador está aberta. Sala, Diagnóstico e Ajustes chegam com o estado
 * que precisam (D2/D4), não como botão morto.
 *
 * # Ao vivo (D-03)
 *
 * `disabled` tira o botão do foco, e com ele a explicação: por teclado e por
 * toque ninguém lia o `title`. Aqui os itens ficam `aria-disabled` (continuam
 * focáveis e anunciam o motivo por `aria-describedby`), e o motivo também está
 * escrito no rodapé do trilho. O item da transmissão vira "NO AR".
 *
 * Rótulos em 10px, num trilho de 104px: em 9px num trilho de 76px o
 * "TRANSMITIR" saía cortado (D-01).
 */
export function TrilhoDesktop({ ativo, travado, aoEscolher }: Props) {
  return (
    <nav
      aria-label="Tela Desktop"
      className="flex w-[104px] shrink-0 flex-col items-center gap-2 border-r-2 border-line bg-bar px-1 py-3"
    >
      {ITENS.map(({ id, rotulo, nome, Icone }) => {
        const atual = id === ativo;
        const noAr = travado && id === 'transmitir';
        const bloqueado = travado && !noAr;
        return (
          <button
            key={id}
            type="button"
            title={bloqueado ? `${nome}: encerre a transmissão antes de sair daqui` : nome}
            aria-current={atual ? 'page' : undefined}
            {...(bloqueado ? { 'aria-disabled': true, 'aria-describedby': ID_DICA } : {})}
            onClick={() => {
              if (!bloqueado) aoEscolher(id);
            }}
            className={[
              'tecla min-h-[64px] w-full flex-col gap-1.5 px-0 text-[10px]',
              atual ? 'tecla-primaria' : '',
              bloqueado ? 'cursor-not-allowed text-dim hover:!text-dim' : '',
            ].join(' ')}
          >
            {noAr ? <Led pisca /> : <Icone className="h-5 w-5" />}
            {noAr ? 'NO AR' : rotulo}
          </button>
        );
      })}

      {travado && (
        <p
          id={ID_DICA}
          className="mt-auto m-0 px-0.5 text-center font-[family-name:var(--font-pixel)] text-[10px] leading-snug text-muted"
        >
          NO AR. ENCERRE PARA SAIR DAQUI
        </p>
      )}
    </nav>
  );
}
