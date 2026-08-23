type Motivo = 'offline' | 'cheio' | 'sem-conexao';

type Props = {
  readonly slug: string;
  readonly motivo?: Motivo;
  readonly maxPeers?: number;
};

/**
 * Estado, não erro.
 *
 * O amigo abre o link antes do jogo começar e deixa a aba aberta — a página
 * conecta sozinha quando a transmissão subir. Sem botão de "tentar de novo":
 * não há nada para ele fazer, e oferecer um botão inútil é pior que nada.
 *
 * Os três motivos existem separados porque a ação de quem lê é diferente em
 * cada um. Um único "não deu" mandaria a pessoa esperar quando ela precisa
 * agir, ou agir quando ela só precisa esperar.
 */
export function OfflineState({ slug, motivo = 'offline', maxPeers = 3 }: Props) {
  const { titulo, situacao, explicacao } = TEXTO[motivo](slug, maxPeers);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="tabular text-[17px] text-text">{titulo}</p>
      <p className="inline-flex items-center gap-2 text-[13px] text-muted">
        <span
          className={`h-1.5 w-1.5 rounded-full animate-live ${
            motivo === 'sem-conexao' ? 'bg-warn' : 'bg-muted'
          }`}
          aria-hidden="true"
        />
        {situacao}
      </p>
      <p className="mt-2 max-w-sm text-[13px] text-muted">{explicacao}</p>
    </div>
  );
}

const TEXTO: Record<
  Motivo,
  (slug: string, maxPeers: number) => { titulo: string; situacao: string; explicacao: string }
> = {
  offline: (slug) => ({
    titulo: `${slug} não está transmitindo`,
    situacao: 'aguardando',
    explicacao: 'Deixe esta aba aberta. O vídeo aparece sozinho quando começar.',
  }),
  cheio: (_slug, maxPeers) => ({
    titulo: `transmissão lotada (${maxPeers}/${maxPeers})`,
    situacao: 'aguardando uma vaga',
    explicacao: 'Assim que alguém sair, você entra sozinho.',
  }),
  'sem-conexao': () => ({
    titulo: 'não foi possível conectar ao vídeo',
    situacao: 'tentando outro caminho',
    explicacao:
      'A transmissão existe, mas a conexão direta entre vocês não fechou — costuma ser NAT restritivo dos dois lados. Continuamos tentando; se persistir, quem transmite precisa configurar um servidor TURN.',
  }),
};
