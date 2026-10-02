import { Botao } from '../components/Botao.js';
import { CabecalhoDaRota } from './CabecalhoDaRota.js';
import { VidroCrt } from '../components/EfeitosTv.js';
import { PainelOsd } from '../components/PainelOsd.js';

type Props = { readonly onHome: () => void };

/**
 * O 404 deste produto quase nunca é "essa página não existe".
 *
 * O roteador só cai aqui quando o caminho não bate com a forma de um slug —
 * ou seja, na prática, quando alguém digitou o link errado, colou com um
 * caractere a mais, ou o Discord encurtou a URL. A resposta útil não é "não
 * encontrada": é DIZER QUAL É A FORMA CERTA, para a pessoa comparar com o que
 * está na barra de endereço.
 *
 * A regra vem de `core/domain/slug.ts` e já era mostrada no campo da tela
 * inicial. Aqui é a mesma frase, no momento em que ela resolve o problema de
 * verdade — não há informação nova, só realocada.
 */
export function NotFound({ onHome }: Props) {
  return (
    <div className="flex min-h-dvh flex-col bg-void">
      <VidroCrt />
      <CabecalhoDaRota marcaHref="/" />
      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <PainelOsd titulo="ENDEREÇO INVÁLIDO" className="w-full max-w-[580px]">
          <div className="flex flex-col items-start gap-5 p-5">
            <p className="m-0 flex items-start gap-2.5 text-[14px] leading-relaxed text-text">
              <span aria-hidden="true" className="font-[family-name:var(--font-pixel)] text-accent">
                !
              </span>
              Confira o endereço que te mandaram.
            </p>

            <p className="numeral m-0 w-full border-2 border-line bg-deep px-4 py-3 text-[clamp(26px,6vw,38px)] text-dim">
              tela.gg/<span className="text-accent-hi">seunome</span>
            </p>

            <Botao tom="primaria" onClick={onHome}>
              IR PARA O INÍCIO
            </Botao>

            <p className="m-0 max-w-[52ch] text-[12px] leading-relaxed text-muted [text-wrap:pretty]">
              Um link de transmissão termina com 3 a 25 caracteres: só letras minúsculas, números e
              hífen, sem hífen no começo nem no fim.
            </p>
          </div>
        </PainelOsd>
      </main>
    </div>
  );
}
