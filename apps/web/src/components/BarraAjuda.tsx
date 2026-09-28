type Props = {
  readonly dicas: readonly { readonly tecla: string; readonly texto: string }[];
  readonly children?: React.ReactNode;
};

/**
 * A barra de rodapé com as teclas do menu, como a legenda de um OSD.
 *
 * Só aparece onde há menu e onde há teclado (`md` para cima): num celular ela
 * seria um rodapé de instruções para teclas que a pessoa não tem.
 */
export function BarraAjuda({ dicas, children }: Props) {
  return (
    <footer className="hidden min-h-10 items-center gap-6 overflow-hidden whitespace-nowrap border-t-2 border-line bg-bar px-6 font-[family-name:var(--font-pixel)] text-[11px] text-dim md:flex">
      {dicas.map((d) => (
        <span key={d.tecla} className="flex items-center gap-2">
          <kbd className="border border-edge px-1.5 py-px font-[inherit] text-text">{d.tecla}</kbd>
          {d.texto}
        </span>
      ))}
      <div className="flex-1" />
      {children}
    </footer>
  );
}
