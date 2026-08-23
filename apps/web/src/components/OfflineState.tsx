type Props = {
  readonly slug: string;
  readonly full?: boolean;
  readonly maxPeers?: number;
};

/**
 * Estado offline, não erro.
 *
 * O amigo abre o link antes do jogo começar e deixa a aba aberta — a página
 * conecta sozinha quando a transmissão subir. Sem botão de "tentar de novo":
 * não há nada para ele fazer, e oferecer um botão inútil é pior que não
 * oferecer nada.
 *
 * "Lotada" é estado próprio, não erro genérico: o limite de espectadores é uma
 * consequência conhecida da arquitetura mesh (o upload do transmissor é
 * finito), e o espectador merece saber que a vaga pode abrir.
 */
export function OfflineState({ slug, full = false, maxPeers = 3 }: Props) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="tabular text-[17px] text-text">
        {full ? `transmissão lotada (${maxPeers}/${maxPeers})` : `${slug} não está transmitindo`}
      </p>
      <p className="inline-flex items-center gap-2 text-[13px] text-dim">
        <span className="h-1.5 w-1.5 rounded-full bg-muted animate-live" aria-hidden="true" />
        {full ? 'aguardando uma vaga' : 'aguardando'}
      </p>
      <p className="mt-2 max-w-xs text-[13px] text-muted">
        {full
          ? 'Assim que alguém sair, você entra sozinho.'
          : 'Deixe esta aba aberta. O vídeo aparece sozinho quando começar.'}
      </p>
    </div>
  );
}
