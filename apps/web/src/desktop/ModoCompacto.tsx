import { Botao } from '../components/Botao.js';
import { Led } from '../components/Led.js';

type Props = {
  /** O link do canal, sem o esquema. */
  readonly link: string;
  readonly tempo: string;
  readonly assistindo: number;
  readonly capacidade: number;
  readonly copiado: boolean;
  readonly aoCopiar: () => void;
  /** Perguntando "encerrar?": a janela é pequena demais para um diálogo, então a pergunta vem no lugar dos botões. */
  readonly confirmando: boolean;
  readonly textoConfirmar: string;
  readonly aoEncerrar: () => void;
  readonly aoConfirmar: () => void;
  readonly aoCancelar: () => void;
  readonly aoExpandir: () => void;
};

/**
 * A janela compacta (D4): uma faixa com o essencial para deixar por cima do
 * jogo. Tudo da transmissão que importa de relance — link, tempo, quantos
 * assistem — e as duas saídas: expandir e encerrar.
 */
export function ModoCompacto({
  link,
  tempo,
  assistindo,
  capacidade,
  copiado,
  aoCopiar,
  confirmando,
  textoConfirmar,
  aoEncerrar,
  aoConfirmar,
  aoCancelar,
  aoExpandir,
}: Props) {
  return (
    <section
      aria-label="Transmissão no ar, janela compacta"
      className="flex h-full w-full flex-col justify-between gap-1.5 bg-bar px-3 py-2"
    >
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2 font-[family-name:var(--font-pixel)] text-[11px] text-live-hi">
          <Led pisca />
          NO AR
        </span>
        <span className="font-[family-name:var(--font-pixel)] text-[11px] text-text">{tempo}</span>
        <span className="font-[family-name:var(--font-pixel)] text-[11px] text-dim" title="Assistindo agora / capacidade">
          {assistindo}/{capacidade} assistindo
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="numeral min-w-0 flex-1 truncate text-[20px] text-accent-hi" title={link}>
          {link}
        </span>
        <button type="button" onClick={aoCopiar} className="tecla !min-h-8 px-2 text-[10px]">
          {copiado ? 'COPIADO' : 'COPIAR'}
        </button>
      </div>
      {confirmando ? (
        <div className="flex items-center gap-2" role="group" aria-label="Confirmar encerramento">
          <span className="min-w-0 flex-1 text-[11px] leading-tight text-text [text-wrap:pretty]">{textoConfirmar}</span>
          <button type="button" onClick={aoCancelar} className="tecla tecla-primaria !min-h-8 px-2 text-[10px]">
            CONTINUAR
          </button>
          <Botao tom="perigo" onClick={aoConfirmar} style={{ minHeight: 32 }}>
            ENCERRAR
          </Botao>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={aoExpandir} className="tecla !min-h-8 px-2 text-[10px]">
            EXPANDIR
          </button>
          <button type="button" onClick={aoEncerrar} className="tecla tecla-perigo !min-h-8 px-2 text-[10px]">
            ENCERRAR
          </button>
        </div>
      )}
    </section>
  );
}
