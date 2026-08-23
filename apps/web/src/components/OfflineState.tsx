type Props = {
  readonly slug: string;
  readonly full?: boolean;
};

/**
 * Estado offline, não erro.
 *
 * O amigo abre o link antes do jogo começar e deixa a aba aberta — a página
 * conecta sozinha quando a transmissão subir. Sem botão de "tentar de novo":
 * não há nada para ele fazer, e oferecer um botão inútil é pior que não
 * oferecer nada.
 */
export function OfflineState({ slug, full = false }: Props) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="tabular text-[17px] text-text">
        {full ? 'a transmissão está cheia' : `${slug} não está transmitindo`}
      </p>
      <p className="inline-flex items-center gap-2 text-[13px] text-dim">
        <span className="h-1.5 w-1.5 rounded-full bg-muted animate-live" aria-hidden="true" />
        {full ? 'aguardando uma vaga' : 'aguardando'}
      </p>
      <p className="mt-2 max-w-xs text-[13px] text-muted">
        Deixe esta aba aberta. O vídeo aparece sozinho quando começar.
      </p>
    </div>
  );
}
