import { Botao } from './Botao.js';
import { IconOk, IconOlho } from './Icon.js';
import { SalaVagas, type Vaga } from './SalaVagas.js';

type Props = {
  /** O link do canal: só o nome (ADR 0026). */
  readonly link: string;
  /** Recém-gerado: a faixa brilha por alguns segundos. */
  readonly novo: boolean;
  readonly copiado: boolean;
  readonly aoCopiar: () => void;
  /** Só as ocupadas; `total` é o teto. */
  readonly vagas: readonly Vaga[];
  readonly total: number;
  /** Tira uma pessoa só da sala (C-08). Sem ele, a lista não tem o botão. */
  readonly aoRemover?: ((id: string) => void) | undefined;
  /** Abre o "TELA NO DISCORD". Sem ele (app do Discord não configurado), sem botão. */
  readonly aoDiscord?: (() => void) | undefined;
};

/**
 * A faixa do link: o que o transmissor mais precisa e mais faz — copiar e
 * mandar para os amigos.
 *
 * O link é só o nome do canal, e dá para ditar na call: quem tem o link entra
 * direto (ADR 0026/0028).
 */
export function FaixaLink({
  link,
  novo,
  copiado,
  aoCopiar,
  vagas,
  total,
  aoRemover,
  aoDiscord,
}: Props) {
  const endereco = link.replace(/^https?:\/\//, '');

  return (
    <div
      className={[
        'relative z-10 flex flex-wrap items-stretch border-2 bg-surface',
        novo ? 'link-novo border-accent' : 'border-edge',
      ].join(' ')}
    >
      <div className="numeral flex items-center bg-accent px-3.5 text-[24px] text-ink">
        CANAL
      </div>

      <div className="flex min-w-[220px] flex-1 flex-col justify-center gap-1 px-4 py-2.5">
        <span className="flex items-center gap-1.5 font-[family-name:var(--font-pixel)] text-[11px] text-ok">
          <IconOk className="h-3 w-3" />
          LINK NO AR. QUEM ABRIR JÁ ESTÁ ASSISTINDO
        </span>
        <span className="numeral min-w-0 truncate text-[clamp(24px,3vw,32px)] text-accent-hi [text-shadow:0_0_10px_rgb(242_169_59_/_0.4)]">
          {endereco}
        </span>
      </div>

      <div className="flex items-center gap-2 px-2.5 py-2">
        <Botao tom="primaria" onClick={aoCopiar}>
          {copiado ? 'LINK COPIADO' : 'COPIAR LINK'}
        </Botao>
        {aoDiscord !== undefined && <Botao onClick={aoDiscord}>DISCORD</Botao>}
      </div>

      <div className="flex items-center border-l-2 border-line">
        <SalaVagas
          vagas={vagas}
          total={total}
          aoRemover={aoRemover}
          icone={<IconOlho className="h-3.5 w-3.5 text-accent" />}
        />
      </div>
    </div>
  );
}
