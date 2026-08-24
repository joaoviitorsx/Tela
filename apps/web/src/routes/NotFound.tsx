import { Panel, PanelSection } from '../components/Panel.js';

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
    <main className="flex min-h-dvh items-center justify-center px-4 py-8 sm:px-6">
      <Panel className="w-full max-w-[560px]">
        <PanelSection rotulo="endereço inválido">
          <div className="flex flex-col items-start gap-4 py-3">
            <p className="text-[17px] leading-relaxed text-text">
              Este endereço não tem a forma de um link de transmissão.
            </p>

            <p className="tabular rounded-md border border-line bg-surface px-3 py-2.5 text-[13px] text-muted">
              tela.gg/<span className="text-text">seunome</span>
            </p>

            <p className="max-w-[46ch] text-[13px] leading-relaxed text-muted">
              O final tem de 3 a 25 caracteres, só letras minúsculas, números e hífen, e não
              começa nem termina com hífen. Confira se o que está na barra de endereço bate com
              o que te mandaram.
            </p>

            <button
              type="button"
              onClick={onHome}
              className="inline-flex min-h-11 items-center rounded-sm border border-edge px-4 text-[13px] font-medium text-text transition-colors duration-150 hover:bg-surface"
            >
              ir para o início
            </button>
          </div>
        </PanelSection>
      </Panel>
    </main>
  );
}
