import { Botao } from '../components/Botao.js';
import { Led } from '../components/Led.js';

type Props = {
  /** `00:42`, `1:02:05`. */
  readonly tempo: string;
  readonly assistindo: number;
  readonly capacidade: number;
  /** `direta`, `TURN`, `mista` ou `—`. */
  readonly rota: string;
  /** `nativo·NVENC`, `WebCodecs·hardware`… ou `—`. */
  readonly encoder: string;
  readonly aoCompactar: (() => void) | null;
  readonly aoEncerrar: () => void;
};

function Dado({ rotulo, valor, tom }: { readonly rotulo: string; readonly valor: string; readonly tom?: 'alerta' | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="font-[family-name:var(--font-pixel)] text-[9px] text-dim">{rotulo}</dt>
      <dd className={`m-0 truncate font-[family-name:var(--font-pixel)] text-[12px] ${tom === 'alerta' ? 'text-accent-hi' : 'text-text'}`}>
        {valor}
      </dd>
    </div>
  );
}

/**
 * O painel "NO AR" no pé do app, à moda do painel de voz do Discord: o que
 * está acontecendo e o botão de parar, sempre à vista, de qualquer tela e
 * mesmo com a janela pequena. Só desenho: os números vêm de `useSegundoPlano`.
 *
 * Não é `aria-live`: o tempo muda a cada segundo e o leitor de tela não
 * deve narrar um relógio. O rótulo da região diz o essencial.
 */
export function PainelNoAr({ tempo, assistindo, capacidade, rota, encoder, aoCompactar, aoEncerrar }: Props) {
  return (
    <section
      aria-label="Transmissão no ar"
      className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-t-2 border-line bg-bar px-4 py-2"
    >
      <span className="flex items-center gap-2 font-[family-name:var(--font-pixel)] text-[12px] text-live-hi">
        <Led pisca />
        NO AR
      </span>
      <dl className="m-0 flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-1">
        <Dado rotulo="TEMPO" valor={tempo} />
        <Dado rotulo="ASSISTINDO" valor={`${assistindo}/${capacidade}`} />
        <Dado rotulo="ROTA" valor={rota} tom={rota === 'TURN' || rota === 'mista' ? 'alerta' : undefined} />
        <Dado rotulo="ENCODER" valor={encoder} />
      </dl>
      <div className="flex items-center gap-2">
        {aoCompactar !== null && (
          <Botao onClick={aoCompactar} title="Reduz a janela a uma faixa com o essencial">
            COMPACTAR
          </Botao>
        )}
        <Botao tom="perigo" onClick={aoEncerrar}>
          ENCERRAR
        </Botao>
      </div>
    </section>
  );
}
