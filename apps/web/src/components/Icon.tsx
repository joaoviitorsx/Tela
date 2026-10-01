type IconProps = { readonly className?: string };

/**
 * Ícones em pixel: grade de 16×16, só retângulos, `crispEdges`.
 *
 * Herdam a cor do texto (`currentColor`). Todos são decorativos — o rótulo
 * acessível mora no botão que os contém, nunca no desenho.
 */
const base = 'h-4 w-4 shrink-0';

function Pixel({
  className = base,
  children,
}: IconProps & { readonly children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconOlho({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M5 3h6v2h3v2h2v2h-2v2h-3v2H5v-2H2V9H0V7h2V5h3z M6 6h4v4H6z" fillRule="evenodd" />
    </Pixel>
  );
}

export function IconOlhoRisco({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M5 3h6v2h3v2h2v2h-2v2h-3v2H5v-2H2V9H0V7h2V5h3z M6 6h4v4H6z" fillRule="evenodd" opacity="0.55" />
      <path d="M1 1h2v2h2v2h2v2h2v2h2v2h2v2h2v2h-2v-2h-2v-2h-2v-2H8V7H6V5H4V3H2V2H1z" fill="var(--color-live-hi)" />
    </Pixel>
  );
}

export function IconTelaCheia({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M1 1h5v2H3v3H1z M10 1h5v5h-2V3h-3z M1 10h2v3h3v2H1z M13 10h2v5h-5v-2h3z" />
    </Pixel>
  );
}

export function IconSairTelaCheia({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M4 1h2v5H1V4h3z M10 1h2v3h3v2h-5z M1 10h5v5H4v-3H1z M10 10h5v2h-3v3h-2z" />
    </Pixel>
  );
}

export function IconPip({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M0 2h16v12H0z M2 4v8h12V4z" fillRule="evenodd" />
      <path d="M8 8h6v4H8z" fill="var(--color-accent)" />
    </Pixel>
  );
}

export function IconMudo({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M2 6h3l3-3h2v10H8l-3-3H2z" />
      <path d="M11 6h2v1h1V6h2v2h-1v1h1v2h-2v-1h-1v1h-2V9h1V8h-1z" />
    </Pixel>
  );
}

export function IconSom({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M2 6h3l3-3h2v10H8l-3-3H2z" />
      <path d="M12 5h2v6h-2z M14 3h2v10h-2z" />
    </Pixel>
  );
}

export function IconCopiar({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M5 1h9v10h-2V3H5z M2 4h9v11H2z M4 6v7h5V6z" fillRule="evenodd" />
    </Pixel>
  );
}

export function IconOk({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M13 3h2v2h-2v2h-2v2H9v2H7v2H5v-2H3V9H1V7h2v2h2v2h2V9h2V7h2V5h2z" />
    </Pixel>
  );
}

/** Um quadrado: o LED de "parar"/"gravando" do aparelho. */
export function IconQuadrado({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M3 3h10v10H3z" />
    </Pixel>
  );
}

/** Barras de sinal: o ícone do botão de diagnóstico. */
export function IconSinal({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M1 11h3v4H1z M6 8h3v7H6z M11 4h3v11h-3z" fill="var(--color-ok)" />
    </Pixel>
  );
}

/** A TV: o item TRANSMITIR do trilho do app. */
export function IconTv({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M4 0h2v3H4z M10 0h2v3h-2z" opacity="0.7" />
      <path d="M1 3h14v10H1z M3 5v6h10V5z" fillRule="evenodd" />
      <path d="M5 13h6v2H5z" />
    </Pixel>
  );
}

/** A chave: o código de recuperação, que é a posse do canal. */
export function IconChave({ className }: IconProps) {
  return (
    <Pixel {...(className ? { className } : {})}>
      <path d="M1 5h6v6H1z M3 7v2h2V7z" fillRule="evenodd" />
      <path d="M7 7h8v2H7z M13 9h2v3h-2z M10 9h2v2h-2z" />
    </Pixel>
  );
}
