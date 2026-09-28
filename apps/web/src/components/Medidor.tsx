export type Tom = 'neutro' | 'destaque' | 'ok' | 'alerta';

export type Medida = {
  readonly rotulo: string;
  readonly valor: string;
  readonly nota?: string;
  readonly tom?: Tom;
};

type Props = {
  readonly medidas: readonly Medida[];
  readonly colunas: 2 | 3 | 4;
  readonly tamanho?: 'p' | 'm' | 'g';
  /** Nome do grupo para leitor de tela. */
  readonly rotulo: string;
};

const COR: Record<Tom, string> = {
  neutro: 'text-text',
  destaque: 'text-accent-hi',
  ok: 'text-ok',
  alerta: 'text-warn',
};

const NUMERAL = { p: 'text-[22px]', m: 'text-[26px]', g: 'text-[34px]' } as const;

const GRADE = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' } as const;

/**
 * Uma grade de leituras: rótulo pequeno, número grande, nota curta.
 *
 * É uma lista de definições (`<dl>`): cada par rótulo/valor é lido junto. O
 * alerta não é só a cor âmbar — o texto da nota (ou o próprio valor, como
 * "VIA TURN") diz o que está diferente, e o número muda de cor por cima.
 */
export function Medidor({ medidas, colunas, tamanho = 'm', rotulo }: Props) {
  return (
    <dl
      aria-label={rotulo}
      className={`m-0 grid ${GRADE[colunas]} border-t-2 border-line`}
    >
      {medidas.map((m) => (
        <div
          key={m.rotulo}
          className="flex min-w-0 flex-col gap-1 border-b-2 border-r-2 border-line px-3.5 py-2.5"
        >
          <dt className="rotulo">{m.rotulo}</dt>
          <dd className={`numeral m-0 truncate ${NUMERAL[tamanho]} ${COR[m.tom ?? 'neutro']}`}>
            {m.valor}
          </dd>
          {m.nota !== undefined && (
            <dd className="m-0 text-[11px] leading-snug text-dim [text-wrap:pretty]">{m.nota}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}
