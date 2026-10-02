import { IconAtualizar, IconChave, IconEngrenagem, IconOlho, IconSinal, IconTv } from '../components/Icon.js';
import { Led } from '../components/Led.js';

export type ItemDoTrilho = 'transmitir' | 'assistir' | 'canal';

type Props = {
  readonly ativo: ItemDoTrilho | null;
  /** Ao vivo: só o item ativo responde. Sair da rota derrubaria a transmissão. */
  readonly travado: boolean;
  readonly aoEscolher: (item: ItemDoTrilho) => void;
  /** AJUSTES: um painel, não uma rota — por isso responde mesmo ao vivo. Sem ele, o item não aparece. */
  readonly aoAjustes?: () => void;
  /** DIAGNÓSTICO: também um painel, não uma rota — responde ao vivo (D-04). */
  readonly aoDiagnostico?: () => void;
  /** Versão nova com algo a fazer (D5). Sem ele, o item não existe. */
  readonly atualizar?: { readonly titulo: string; readonly aoClicar: () => void };
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
 * rota do espectador está aberta. AJUSTES (D4) é
 * o mesmo caso: abre um painel, e por isso nunca trava. Sala e Diagnóstico
 * chegam com o estado que precisam, não como botão morto.
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
 *
 * # Janela estreita (D-05)
 *
 * Abaixo de 760px de largura o trilho encolhe para 56px e fica só com os
 * ícones: o nome continua no `title` e para o leitor de tela (`sr-only`), e o
 * conteúdo ganha os 48px de volta.
 *
 * # DIAG (D-04)
 *
 * O cabeçalho do site não existe no app; o DIAGNÓSTICO que ele trazia mora
 * aqui, junto de AJUSTES, e abre o mesmo painel por `painel-diagnostico`.
 */
const ESTREITO = 'max-[759px]';
export function TrilhoDesktop({ ativo, travado, aoEscolher, aoAjustes, aoDiagnostico, atualizar }: Props) {
  return (
    <nav
      aria-label="Tela Desktop"
      className={`flex w-[104px] ${ESTREITO}:w-14 shrink-0 flex-col items-center gap-2 border-r-2 border-line bg-bar px-1 py-3`}
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
            <span className={`${ESTREITO}:sr-only`}>{noAr ? 'NO AR' : rotulo}</span>
          </button>
        );
      })}

      <div className="mt-auto flex w-full flex-col items-center gap-2">
        {travado && (
          <p
            id={ID_DICA}
            className={`m-0 px-0.5 text-center font-[family-name:var(--font-pixel)] text-[10px] leading-snug text-muted ${ESTREITO}:sr-only`}
          >
            NO AR. ENCERRE PARA SAIR DAQUI
          </p>
        )}
        {atualizar !== undefined && (
          <button
            type="button"
            title={atualizar.titulo}
            aria-label={atualizar.titulo}
            onClick={atualizar.aoClicar}
            className="tecla min-h-[64px] w-full flex-col gap-1.5 border-accent px-0 text-[10px] text-accent-hi"
          >
            <IconAtualizar className="h-5 w-5" />
            <span aria-hidden="true" className={`${ESTREITO}:sr-only`}>
              ATUALIZAR
            </span>
          </button>
        )}
        {aoDiagnostico !== undefined && (
          <button
            type="button"
            title="Diagnóstico de rede e conexões"
            onClick={aoDiagnostico}
            className="tecla min-h-[64px] w-full flex-col gap-1.5 px-0 text-[10px]"
          >
            <IconSinal className="h-5 w-5" />
            <span className={`${ESTREITO}:sr-only`}>DIAG</span>
          </button>
        )}
        {aoAjustes !== undefined && (
          <button
            type="button"
            title="Ajustes do app"
            onClick={aoAjustes}
            className="tecla min-h-[64px] w-full flex-col gap-1.5 px-0 text-[10px]"
          >
            <IconEngrenagem className="h-5 w-5" />
            <span className={`${ESTREITO}:sr-only`}>AJUSTES</span>
          </button>
        )}
      </div>
    </nav>
  );
}
