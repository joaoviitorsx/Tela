import { APELIDO_MAX } from '@tela/shared';
import { Botao } from './Botao.js';
import { Marca } from './Marca.js';

type Props = {
  readonly slug: string;
  readonly valor: string;
  readonly aoMudar: (valor: string) => void;
  readonly aoEnviar: () => void;
  /** O apelido digitado não passa na regra (longo demais, caractere estranho). */
  readonly invalido: boolean;
  /** Há um apelido válido para mandar. */
  readonly pronto: boolean;
};

/**
 * Antes de pedir para assistir: como quem transmite vai ver você (ADR 0025).
 *
 * O mesmo aparelho da sala de espera — chiado, moldura, o canal em numeral —
 * para a pessoa entender que já está no lugar certo e só falta dizer quem é.
 * Pede uma vez: o apelido fica neste navegador e vai sozinho da próxima vez.
 */
export function EntradaDeApelido({ slug, valor, aoMudar, aoEnviar, invalido, pronto }: Props) {
  return (
    <div className="chiado-suave relative flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="absolute left-4 top-4 sm:left-6 sm:top-5">
        <Marca tamanho="pequeno" />
      </div>

      <form
        className="acima-do-crt entra w-full max-w-[680px] border-2 border-edge bg-[rgb(8_8_10_/_0.94)] shadow-[0_0_0_2px_#000]"
        onSubmit={(e) => {
          e.preventDefault();
          aoEnviar();
        }}
      >
        <div className="flex flex-col items-center gap-5 px-5 py-9 text-center sm:px-8 sm:py-11">
          <p className="m-0 font-[family-name:var(--font-pixel)] text-[13px] text-muted">
            transmissão privada
          </p>
          <h1 className="numeral m-0 max-w-full truncate text-[clamp(38px,9vw,64px)] text-accent-hi [text-shadow:0_0_18px_rgb(242_169_59_/_0.4)]">
            <span className="text-dim">tela.gg/</span>
            {slug}
          </h1>
          <p className="m-0 max-w-[46ch] text-[12.5px] leading-relaxed text-muted [text-wrap:pretty]">
            Quem transmite aceita cada pessoa que entra. Use o nome pelo qual a galera te
            conhece — é o que aparece no pedido.
          </p>

          <label className="flex w-full max-w-[420px] flex-col gap-2 text-left">
            <span className="rotulo">SEU APELIDO</span>
            <input
              value={valor}
              onChange={(e) => aoMudar(e.target.value)}
              maxLength={APELIDO_MAX}
              autoFocus
              autoComplete="nickname"
              spellCheck={false}
              aria-invalid={invalido}
              aria-describedby="ajuda-apelido"
              className="min-h-12 w-full border-2 border-line bg-deep px-3 font-[family-name:var(--font-pixel)] text-[18px] text-accent-hi outline-none focus-visible:border-accent"
              placeholder="ex.: joão"
            />
            <span id="ajuda-apelido" className={`text-[11.5px] ${invalido ? 'text-warn' : 'text-dim'}`}>
              {invalido ? `Use de 1 a ${APELIDO_MAX} caracteres.` : `Até ${APELIDO_MAX} caracteres. Fica salvo neste navegador.`}
            </span>
          </label>

          <Botao tom="primaria" type="submit" disabled={!pronto}>
            PEDIR PARA ASSISTIR
          </Botao>
        </div>
      </form>
    </div>
  );
}
