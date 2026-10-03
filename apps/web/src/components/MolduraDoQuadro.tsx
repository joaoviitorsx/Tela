import { IconFechar, IconTrocar } from './Icon.js';
import { Led } from './Led.js';

type Props = {
  readonly canal: string;
  readonly aoVivo: boolean;
  /** Sem imagem: o que está acontecendo, numa linha ("SINTONIZANDO"). */
  readonly aviso: string | null;
  /** A guarda de banda pausou este canal (ADR 0032). */
  readonly pausa: { readonly texto: string; readonly aoRetomar: () => void } | null;
  /** O último quadro antes da pausa, para o quadro não ficar preto. */
  readonly congelado: string | null;
  /** Toque: as ações ficam sempre à vista — não existe hover. */
  readonly comToque: boolean;
  /** Nome e ações no topo: quando o quadro é meia tela, o pé fica sob a barra de baixo. */
  readonly rotuloNoTopo: boolean;
  /** O botão de tamanho só faz sentido no quadro do canto. */
  readonly tamanho: { readonly rotulo: string; readonly aoMudar: () => void } | null;
  readonly aoTrocar: () => void;
  readonly aoFechar: () => void;
};

/**
 * A moldura do canal que NÃO é a principal: o quadro inteiro é a tecla de
 * trocar (é o que a pessoa vai tentar primeiro), com o nome do canal no pé e
 * duas ações pequenas. É uma CAMADA por cima do vídeo, e não um invólucro:
 * o `<video>` fica no mesmo lugar da árvore seja o canal principal ou não, e
 * a troca nunca o desmonta (ADR 0032).
 */
export function MolduraDoQuadro({
  canal,
  aoVivo,
  aviso,
  pausa,
  congelado,
  comToque,
  rotuloNoTopo,
  tamanho,
  aoTrocar,
  aoFechar,
}: Props) {
  const acoes = comToque
    ? 'opacity-100'
    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100';
  return (
    <div className="group absolute inset-0 overflow-hidden border-2 border-edge shadow-[0_0_0_2px_#000,0_12px_32px_rgb(0_0_0_/_0.6)]">
      {congelado !== null && pausa !== null && (
        <img src={congelado} alt="" className="absolute inset-0 h-full w-full object-contain opacity-60" />
      )}

      {(aviso !== null || pausa !== null) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-2 text-center">
          <span className="font-[family-name:var(--font-pixel)] text-[10px] leading-relaxed text-accent-hi sm:text-[11px]">
            {pausa?.texto ?? aviso}
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={aoTrocar}
        onDoubleClick={(e) => e.stopPropagation()}
        title={`Assistir ${canal} na tela principal (T)`}
        aria-label={`Trocar para ${canal} (T)`}
        className="absolute inset-0 cursor-pointer border-0 bg-transparent p-0 outline-offset-[-4px] hover:bg-white/5"
      />

      {pausa !== null && (
        <button
          type="button"
          onClick={pausa.aoRetomar}
          className="tecla tecla-primaria absolute bottom-9 left-1/2 min-h-9 -translate-x-1/2 px-3 text-[10px]"
        >
          RETOMAR
        </button>
      )}

      <div
        className={[
          'pointer-events-none absolute inset-x-0 flex items-center gap-1.5 px-2',
          rotuloNoTopo
            ? 'top-0 bg-gradient-to-b from-black/85 to-transparent pb-5 pt-1.5'
            : 'bottom-0 bg-gradient-to-t from-black/85 to-transparent pb-1.5 pt-5',
        ].join(' ')}
      >
        <Led cor={aoVivo ? 'vivo' : 'ambar'} pisca={aoVivo} />
        <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-pixel)] text-[10px] text-text">
          {canal}
        </span>
        <span className={`pointer-events-auto flex items-center gap-1 transition-opacity duration-150 ${acoes}`}>
          <span aria-hidden="true" className="hidden text-accent sm:inline">
            <IconTrocar className="h-3.5 w-3.5" />
          </span>
          {tamanho !== null && (
            <button
              type="button"
              onClick={tamanho.aoMudar}
              title={`Tamanho do quadro: ${tamanho.rotulo} ([ ])`}
              aria-label={`Tamanho do quadro: ${tamanho.rotulo}`}
              className="flex h-8 min-w-8 items-center justify-center border-2 border-edge bg-ink px-1 font-[family-name:var(--font-pixel)] text-[10px] text-text hover:border-accent hover:text-accent-hi"
            >
              {tamanho.rotulo}
            </button>
          )}
          <button
            type="button"
            onClick={aoFechar}
            title={`Fechar ${canal} (X)`}
            aria-label={`Fechar ${canal} (X)`}
            className="flex h-8 w-8 items-center justify-center border-2 border-edge bg-ink text-text hover:border-danger-edge hover:text-danger"
          >
            <IconFechar className="h-3 w-3" />
          </button>
        </span>
      </div>
    </div>
  );
}
