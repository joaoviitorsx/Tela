type Props = {
  readonly cor?: 'vivo' | 'branco' | 'ok';
  /** Pisca em laço de 1s. Só para o que está AO VIVO, e para com a aba oculta. */
  readonly pisca?: boolean;
};

const COR = { vivo: 'bg-live-hi', branco: 'bg-white', ok: 'bg-ok' } as const;

/**
 * O LED quadrado de 8px. É o único elemento que anima em laço contínuo no
 * produto, e é de propósito o menor: repintar 64px por segundo não aparece em
 * nenhum perfil de GPU, e ele diz "no ar" sem que ninguém precise ler.
 */
export function Led({ cor = 'vivo', pisca = false }: Props) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 ${COR[cor]} ${pisca ? 'led-pisca' : ''}`}
    />
  );
}
