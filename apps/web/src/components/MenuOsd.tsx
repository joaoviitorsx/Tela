import { useId } from 'react';

export type LinhaMenu =
  | {
      readonly id: string;
      readonly tipo: 'ciclo';
      readonly rotulo: string;
      /** O valor escolhido, já formatado: "1080p60". */
      readonly valor: string;
      readonly indice: number;
      readonly total: number;
      readonly ajuda: string;
    }
  | {
      readonly id: string;
      readonly tipo: 'barra';
      readonly rotulo: string;
      /** 0 a 100, em passos de 10. */
      readonly valor: number;
      readonly ajuda: string;
    };

type PropsLinha = {
  readonly ref: (el: HTMLElement | null) => void;
  readonly tabIndex: 0 | -1;
  readonly 'data-linha': string;
  readonly onFocus: () => void;
};

type Props = {
  readonly linhas: readonly LinhaMenu[];
  /** A linha com o `tabindex=0` — a "selecionada" do menu. */
  readonly ativo: string | null;
  readonly propsContainer: { readonly onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void };
  readonly propsLinha: (id: string) => PropsLinha;
  readonly aoAjustar: (id: string, direcao: -1 | 1) => void;
  readonly aoDefinirBarra: (id: string, porcento: number) => void;
  readonly aoSelecionar: (id: string) => void;
  /** Nome do grupo para leitor de tela: "Ajustes da imagem". */
  readonly rotulo: string;
};

/**
 * O menu de ajustes, à moda de televisor: `↑↓` escolhe a linha, `←→` muda o
 * valor. A navegação vem pronta de `useMenuOsd`; aqui só há desenho.
 *
 * # ARIA
 *
 * Cada linha é um `spinbutton` (valores discretos, `aria-valuetext` com o
 * nome) ou um `slider` (a barra, 0–100). São os papéis que prometem
 * exatamente o teclado que implementamos: setas mudam o valor. O que fica
 * fora deles — os botões ◀ ▶ e os blocos — é para mouse e toque, some da
 * ordem de tabulação e não é lido: o valor já é dito pela linha.
 *
 * A ajuda da linha ativa é `aria-describedby` dela, então o leitor de tela lê
 * "o que isto faz" junto com o valor, sem `aria-live` anunciando a cada seta.
 */
export function MenuOsd({
  linhas,
  ativo,
  propsContainer,
  propsLinha,
  aoAjustar,
  aoDefinirBarra,
  aoSelecionar,
  rotulo,
}: Props) {
  const idAjuda = useId();
  const linhaAtiva = linhas.find((l) => l.id === ativo) ?? null;

  return (
    <div>
      <div role="group" aria-label={rotulo} className="flex flex-col gap-0.5 p-2" {...propsContainer}>
        {linhas.map((linha) => {
          const selecionada = linha.id === ativo;
          const comuns = {
            ...propsLinha(linha.id),
            'aria-label': linha.rotulo,
            'aria-describedby': selecionada ? idAjuda : undefined,
          };

          return (
            <div
              key={linha.id}
              data-ativo={selecionada}
              className={[
                'linha-osd grid min-h-11 items-center gap-x-3 px-3 py-1',
                'grid-cols-[minmax(0,1fr)_auto]',
                selecionada ? 'bg-accent text-ink' : 'text-text',
              ].join(' ')}
              onClick={() => aoSelecionar(linha.id)}
            >
              {linha.tipo === 'ciclo' ? (
                <>
                  <div
                    role="spinbutton"
                    aria-valuemin={0}
                    aria-valuemax={linha.total - 1}
                    aria-valuenow={linha.indice}
                    aria-valuetext={linha.valor}
                    className="flex min-h-11 items-center gap-2.5 font-[family-name:var(--font-pixel)] text-[12px] outline-none"
                    {...comuns}
                  >
                    <Cursor visivel={selecionada} />
                    {linha.rotulo}
                  </div>
                  <div className="flex items-center">
                    <Seta lado="esq" rotulo={`${linha.rotulo}: anterior`} aoClicar={() => aoAjustar(linha.id, -1)} />
                    <span
                      aria-hidden="true"
                      className="min-w-[72px] px-0.5 text-center font-[family-name:var(--font-pixel)] text-[12px] sm:min-w-[88px]"
                    >
                      {linha.valor}
                    </span>
                    <Seta lado="dir" rotulo={`${linha.rotulo}: próximo`} aoClicar={() => aoAjustar(linha.id, 1)} />
                  </div>
                </>
              ) : (
                <>
                  <div
                    role="slider"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={linha.valor}
                    aria-valuetext={`${linha.valor}%`}
                    className="col-span-2 flex min-h-11 items-center gap-2.5 font-[family-name:var(--font-pixel)] text-[12px] outline-none"
                    {...comuns}
                  >
                    <Cursor visivel={selecionada} />
                    {linha.rotulo}
                  </div>
                  <div className="col-span-2 -mt-1 flex items-center gap-[3px] pb-1">
                    <Seta lado="esq" rotulo={`${linha.rotulo}: diminuir`} aoClicar={() => aoAjustar(linha.id, -1)} />
                    <div aria-hidden="true" className="flex flex-1 items-center gap-[3px]">
                      {Array.from({ length: 10 }, (_, j) => (
                        <button
                          key={j}
                          type="button"
                          tabIndex={-1}
                          aria-hidden="true"
                          onClick={() => aoDefinirBarra(linha.id, (j + 1) * 10)}
                          className="flex h-11 flex-1 items-center border-0 bg-transparent p-0"
                        >
                          <span
                            className={[
                              'block h-3.5 w-full bg-current',
                              j < linha.valor / 10 ? 'opacity-100' : 'opacity-20',
                            ].join(' ')}
                          />
                        </button>
                      ))}
                    </div>
                    <Seta lado="dir" rotulo={`${linha.rotulo}: aumentar`} aoClicar={() => aoAjustar(linha.id, 1)} />
                    <span aria-hidden="true" className="numeral w-11 text-right text-[22px]">
                      {linha.valor}
                    </span>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <p
        id={idAjuda}
        className="min-h-[76px] border-t-2 border-line px-5 py-3 text-[12px] leading-relaxed text-muted [text-wrap:pretty]"
      >
        {linhaAtiva?.ajuda ?? ''}
      </p>
    </div>
  );
}

function Cursor({ visivel }: { readonly visivel: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'h-0 w-0 border-y-[5px] border-l-[7px] border-y-transparent border-l-current',
        visivel ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
    />
  );
}

/**
 * A seta ◀ ▶: triângulo de CSS, 44px de alvo, fora da ordem de tabulação.
 *
 * O clique sobe até a linha, que a seleciona — o mesmo que clicar no rótulo.
 */
function Seta({
  lado,
  rotulo,
  aoClicar,
}: {
  readonly lado: 'esq' | 'dir';
  readonly rotulo: string;
  readonly aoClicar: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={rotulo}
      onClick={aoClicar}
      className="flex h-11 w-8 items-center justify-center border-0 bg-transparent p-0 text-current"
    >
      <span
        aria-hidden="true"
        className={[
          'h-0 w-0 border-y-[6px] border-y-transparent',
          lado === 'esq' ? 'border-r-[7px] border-r-current' : 'border-l-[7px] border-l-current',
        ].join(' ')}
      />
    </button>
  );
}
