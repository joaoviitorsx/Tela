import { Botao } from './Botao.js';
import { IconOk, IconOlho } from './Icon.js';
import { SalaVagas, type Vaga } from './SalaVagas.js';

type Props = {
  /** O link completo, com `#k=convite`. */
  readonly link: string;
  /** Recém-gerado: a faixa brilha por alguns segundos. */
  readonly novo: boolean;
  readonly copiado: boolean;
  readonly aoCopiar: () => void;
  readonly vagas: readonly Vaga[];
  readonly total: number;
  readonly ocupadas: number;
};

/**
 * A faixa do link: o que o transmissor mais precisa e mais faz — copiar e
 * mandar para os amigos.
 *
 * O link é PRIVADO (sala por convite): o que vem depois do `#` é a chave. A
 * faixa mostra o endereço curto em destaque e a parte do convite em corpo
 * pequeno, para ficar claro que o link inteiro é o que se manda — e que
 * copiar é mais seguro que ler em voz alta.
 */
export function FaixaLink({
  link,
  novo,
  copiado,
  aoCopiar,
  vagas,
  total,
  ocupadas,
}: Props) {
  const semProtocolo = link.replace(/^https?:\/\//, '');
  const corte = semProtocolo.indexOf('#');
  const endereco = corte < 0 ? semProtocolo : semProtocolo.slice(0, corte);
  const convite = corte < 0 ? '' : semProtocolo.slice(corte);

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
          LINK PRIVADO GERADO. MANDE O LINK INTEIRO
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="numeral truncate text-[clamp(24px,3vw,32px)] text-accent-hi [text-shadow:0_0_10px_rgb(242_169_59_/_0.4)]">
            {endereco}
          </span>
          {convite !== '' && (
            <span className="hidden max-w-[16ch] truncate text-[11px] text-dim sm:inline" title="A chave do convite. Vai junto quando você copia.">
              {convite}
            </span>
          )}
        </span>
      </div>

      <div className="flex items-center gap-2 px-2.5 py-2">
        <Botao tom="primaria" onClick={aoCopiar}>
          {copiado ? 'LINK COPIADO' : 'COPIAR LINK'}
        </Botao>
      </div>

      <div className="flex items-center border-l-2 border-line">
        <SalaVagas
          vagas={vagas}
          total={total}
          ocupadas={ocupadas}
          icone={<IconOlho className="h-3.5 w-3.5 text-accent" />}
        />
      </div>
    </div>
  );
}
