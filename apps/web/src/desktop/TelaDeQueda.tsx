import { TEXTO_DA_QUEDA, type MotivoDeQueda } from './queda.js';

type Props = {
  readonly motivo: MotivoDeQueda;
  readonly aoVoltar: () => void;
};

/**
 * A tela depois que a interface caiu (D4). Honesta: a transmissão acabou, os
 * amigos perderam a imagem, e nada foi restaurado. Um botão, o caminho de volta.
 */
export function TelaDeQueda({ motivo, aoVoltar }: Props) {
  return (
    <main className="flex h-dvh w-full items-center justify-center bg-void p-6">
      <div className="flex w-full max-w-[560px] flex-col gap-5 border-2 border-danger-edge bg-bar p-6 shadow-[0_0_0_2px_#000]">
        <h1 className="numeral m-0 text-[clamp(32px,6vw,56px)] leading-[0.95] text-danger [text-shadow:3px_3px_0_#000]">
          A TRANSMISSÃO CAIU
        </h1>
        <p role="alert" className="m-0 text-[14px] leading-relaxed text-text [text-wrap:pretty]">
          {TEXTO_DA_QUEDA[motivo]} Quem estava assistindo perdeu a imagem, e a transmissão não foi retomada. Para
          voltar ao ar, comece de novo.
        </p>
        <p className="m-0 font-[family-name:var(--font-pixel)] text-[10px] text-dim">MOTIVO: {motivo}</p>
        <div>
          <button type="button" onClick={aoVoltar} autoFocus className="tecla tecla-primaria">
            VOLTAR AO INÍCIO
          </button>
        </div>
      </div>
    </main>
  );
}
