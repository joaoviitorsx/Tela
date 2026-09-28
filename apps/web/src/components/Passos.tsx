export type Passo = {
  readonly n: string;
  readonly rotulo: string;
  readonly estado: 'atual' | 'feito' | 'pendente' | 'bloqueado';
  /** Ausente = o passo não é alcançável daqui. */
  readonly aoIr?: () => void;
};

type Props = { readonly passos: readonly Passo[] };

/**
 * A trilha dos quatro passos, no topo do assistente.
 *
 * Lista ordenada de verdade (`<ol>`): quem lê com leitor de tela ouve "lista,
 * 4 itens" e o passo atual marcado com `aria-current="step"`. Passo alcançável
 * é botão; o resto é texto — um botão desabilitado é ruído na tabulação.
 *
 * O "✓" do feito é conteúdo, não decoração: cor sozinha não diz "concluído".
 */
export function Passos({ passos }: Props) {
  return (
    <nav aria-label="Passos da transmissão">
      <ol className="m-0 flex list-none flex-wrap gap-1 p-0">
        {passos.map((p) => {
          const atual = p.estado === 'atual';
          const feito = p.estado === 'feito';
          const cores = atual
            ? 'bg-accent text-ink border-accent'
            : feito
              ? 'bg-surface text-ok border-line'
              : p.aoIr !== undefined
                ? 'bg-surface text-muted border-line'
                : 'bg-surface text-faint border-line';
          const conteudo = (
            <>
              <span className="numeral text-[22px]">{p.n}</span>
              <span className="font-[family-name:var(--font-pixel)] text-[11px]">
                {feito ? `✓ ${p.rotulo}` : p.rotulo}
              </span>
            </>
          );
          const caixa = `flex min-h-11 items-center gap-2.5 border-2 pl-2.5 pr-3.5 ${cores}`;

          return (
            <li key={p.n} {...(atual ? { 'aria-current': 'step' as const } : {})}>
              {p.aoIr !== undefined && !atual ? (
                <button type="button" onClick={p.aoIr} className={`${caixa} hover:border-accent-lo`}>
                  {conteudo}
                </button>
              ) : (
                <span className={caixa}>{conteudo}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
