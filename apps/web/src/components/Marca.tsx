type Props = {
  /** Sem `href` a marca não é link — e no console ao vivo ela NÃO pode ser. */
  readonly href?: string;
  readonly tamanho?: 'normal' | 'pequeno';
};

/**
 * A plaqueta: TELA em numeral de placar, sobre âmbar, com relevo.
 *
 * Ao vivo ela é só um desenho. Um link para a tela inicial ali derrubaria a
 * transmissão com um clique perdido — a página fecha a sessão ao sair.
 */
export function Marca({ href, tamanho = 'normal' }: Props) {
  const placa = (
    <span
      className={[
        'numeral inline-flex items-center border-2 border-accent-lit border-b-accent-lo border-r-accent-lo bg-accent text-ink',
        tamanho === 'normal'
          ? 'h-8 px-2.5 text-[28px] tracking-[0.12em]'
          : 'h-[22px] px-1.5 text-[17px] tracking-[0.1em]',
      ].join(' ')}
    >
      TELA
    </span>
  );

  /*
    A TV do ícone ao lado da plaqueta, só no tamanho normal: na janelinha
    compacta do app o espaço é da plaqueta. `alt` vazio — o nome já está na
    plaqueta, e o leitor de tela não precisa ouvir "Tela" duas vezes.
  */
  const conteudo =
    tamanho === 'normal' ? (
      <span className="inline-flex items-center gap-2">
        <img src="/tela-app-icon.png" alt="" width={32} height={32} className="h-8 w-8" />
        {placa}
      </span>
    ) : (
      placa
    );

  if (href === undefined) return <span className="inline-flex">{conteudo}</span>;

  return (
    <a
      href={href}
      aria-label="Tela, ir para o início"
      className="inline-flex min-h-11 items-center hover:opacity-90"
    >
      {conteudo}
    </a>
  );
}
