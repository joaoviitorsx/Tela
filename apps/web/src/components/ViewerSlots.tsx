type Props = {
  /** Teto do canal. Vem da sessão; o componente não sabe qual é. */
  readonly total: number;
  /** Conectados de verdade, recebendo vídeo. */
  readonly conectados: number;
  /** Destes, quantos passam por TURN — latência maior e cota consumida. */
  readonly viaRelay: number;
  /** Ainda negociando. Conta como ocupando a vaga, porque ocupa. */
  readonly conectando: number;
};

type Estado = 'relay' | 'direto' | 'negociando' | 'vaga';

/**
 * As vagas do canal, uma por marca.
 *
 * O HUD já dizia `2/5` e `1 via relay` em texto. Isto é o MESMO dado desenhado
 * — nada de novo entrou. O que muda é o tempo de leitura: numa olhada de meio
 * segundo entre duas partidas, cinco marcas dizem "cheio", "sobra vaga" e "um
 * está pior que os outros" sem ninguém precisar ler nada.
 *
 * São vagas, não pessoas. `PeerInfo` tem `id`, e o produto já decidiu no HUD
 * do espectador que contagem não vira lista — "sem entregar o identificador de
 * ninguém". Mostrar cinco quadradinhos anônimos respeita a mesma decisão do
 * lado de quem transmite: dá o estado da malha e não dá quem é quem.
 *
 * Quadrado, não bolinha: a bolinha deste produto é o LED do AO VIVO, e ela
 * pulsa. Duas famílias de forma para dois significados diferentes.
 *
 * Nada aqui é comunicado só por cor (ADR 0008 §3): a linha de texto ao lado
 * repete a contagem, e o relay tem forma própria — quadrado vazado com miolo,
 * não só um quadrado âmbar.
 */
export function ViewerSlots({ total, conectados, viaRelay, conectando }: Props) {
  const diretos = Math.max(0, conectados - viaRelay);
  const marcas: Estado[] = [];
  for (let i = 0; i < viaRelay; i += 1) marcas.push('relay');
  for (let i = 0; i < diretos; i += 1) marcas.push('direto');
  for (let i = 0; i < conectando; i += 1) marcas.push('negociando');
  while (marcas.length < total) marcas.push('vaga');

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex items-center gap-1.5" aria-hidden="true">
        {marcas.slice(0, total).map((estado, i) => (
          <span key={i} className={`h-2.5 w-2.5 rounded-[2px] ${PINTURA[estado]}`} />
        ))}
      </span>

      <span className="tabular text-[13px] text-muted">
        {conectados} de {total}
        {conectando > 0 && ` · ${conectando} entrando`}
      </span>

      {viaRelay > 0 && (
        <span
          className="tabular text-[12px] text-warn"
          title="Conexão indireta, via servidor de relay: latência maior e cota consumida."
        >
          {viaRelay} via relay
        </span>
      )}
    </div>
  );
}

const PINTURA: Record<Estado, string> = {
  /* Miolo vazado: o relay se distingue pela FORMA antes da cor. */
  relay: 'border-2 border-warn bg-transparent',
  direto: 'bg-text',
  negociando: 'animate-live bg-muted',
  vaga: 'border border-edge bg-transparent',
};
