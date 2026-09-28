/**
 * Teste de rede ANTES de transmitir: o que a máquina consegue ver de fora.
 *
 * Porta porque exige `RTCPeerConnection` de verdade (R1/R3). O resultado é
 * cru — candidatos ICE sem endereço — e quem interpreta é `sonda-de-rede.ts`,
 * puro e testado.
 */
export type CandidatoVisto = {
  /** `host`, `srflx`, `relay`, `prflx`. */
  readonly tipo: string;
  /**
   * Porta pública vista pelo STUN (`srflx`); `null` nos outros. Nunca o IP.
   * A porta LOCAL não serve: o Chrome a esconde (`relatedPort: 0`).
   */
  readonly portaPublica: number | null;
};

export type ResultadoBrutoSonda = {
  readonly candidatos: readonly CandidatoVisto[];
  /** Tempo até o primeiro `srflx`, em ms. `null` se nenhum veio. */
  readonly primeiraRespostaMs: number | null;
  /** Nome do erro, se a coleta falhou antes de começar. */
  readonly erro: string | null;
};

export type SondaDeRede = {
  /** `aoProgresso` recebe de 0 a 1 enquanto a coleta anda. */
  testar(aoProgresso: (fracao: number) => void): Promise<ResultadoBrutoSonda>;
};
