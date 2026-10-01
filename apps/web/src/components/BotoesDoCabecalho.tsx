import { IconSinal } from './Icon.js';

type Props = {
  readonly aoDiagnostico: () => void;
  /** Sem ação, sem botão: dentro do próprio app não há o que baixar. */
  readonly aoBaixarApp?: (() => void) | undefined;
};

/** DIAGNÓSTICO e BAIXAR APP, os dois botões fixos da faixa de cima do protótipo. */
export function BotoesDoCabecalho({ aoDiagnostico, aoBaixarApp }: Props) {
  return (
    <>
      <button type="button" onClick={aoDiagnostico} className="tecla">
        <IconSinal className="h-3 w-3" />
        <span className="hidden sm:inline">DIAGNÓSTICO</span>
        <span className="sr-only sm:hidden">Diagnóstico</span>
      </button>
      {aoBaixarApp !== undefined && (
        <button type="button" onClick={aoBaixarApp} className="tecla">
          <svg width="12" height="12" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
            <path d="M5 0h2v6h2v2H8v1H7v1H5V9H4V8H3V6h2z M0 10h12v2H0z" fill="currentColor" className="text-accent" />
          </svg>
          <span className="hidden sm:inline">BAIXAR APP</span>
          <span className="sr-only sm:hidden">Baixar app</span>
        </button>
      )}
    </>
  );
}
