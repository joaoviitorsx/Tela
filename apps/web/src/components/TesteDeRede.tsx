import { Botao } from './Botao.js';

type Props = {
  readonly testando: boolean;
  readonly blocos: number;
  readonly total: number;
  readonly aoTestar: () => void;
};

/** O botão do protótipo com a barra em blocos. Burro: o hook anda a barra. */
export function TesteDeRede({ testando, blocos, total, aoTestar }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-3.5">
      <Botao tom="primaria" onClick={aoTestar} disabled={testando}>
        {testando ? 'TESTANDO…' : 'TESTAR REDE'}
      </Botao>
      <div
        className="flex gap-[3px]"
        role="progressbar"
        aria-label="Progresso do teste de rede"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={blocos}
      >
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={`h-[18px] w-3 bg-accent ${i < blocos ? 'opacity-100' : 'opacity-15'}`}
          />
        ))}
      </div>
    </div>
  );
}
