import type { ResultadoBrutoSonda } from '../ports/sonda-de-rede.js';

/**
 * O que o teste de rede permite AFIRMAR, e nada além (diagnóstico pré-ar).
 *
 * O teste consulta DOIS servidores STUN pela MESMA conexão. Em NAT comum
 * os dois veem o mesmo mapeamento, e o Chrome funde as respostas: um `srflx`
 * por saída local. Em NAT simétrico cada servidor vê uma porta diferente, e
 * aparecem MAIS `srflx` do que saídas locais.
 *
 * - `srflx` presente, sem sobra: conexão direta provável. "Provável": a rede
 *   de quem assiste também decide.
 * - Mais `srflx` que candidatos locais: NAT simétrico. Direta com quem está
 *   fora é improvável; a transmissão vai depender de TURN.
 * - Nenhum `srflx`: UDP de saída bloqueado ou STUN fora. Só TURN salva.
 *
 * Medido: a primeira versão usava uma conexão por servidor e comparava pela
 * porta local — que o Chrome esconde (`relatedPort: 0`). Saídas diferentes
 * pareciam o mesmo socket, e um NAT comum saía "simétrico".
 *
 * A subida em Mbps NÃO sai daqui: medir exige mandar tráfego para algum lugar,
 * e o produto não tem servidor de mídia. Ela é medida ao vivo.
 */
export type ConclusaoSonda =
  | { readonly direta: 'provavel'; readonly respostaMs: number | null }
  | { readonly direta: 'improvavel'; readonly respostaMs: number | null }
  | { readonly direta: 'bloqueada'; readonly respostaMs: null }
  | { readonly direta: 'falhou'; readonly erro: string };

export function concluirSonda(bruto: ResultadoBrutoSonda): ConclusaoSonda {
  if (bruto.erro !== null) return { direta: 'falhou', erro: bruto.erro };
  const srflx = bruto.candidatos.filter((c) => c.tipo === 'srflx' && c.portaPublica !== null);
  if (srflx.length === 0) return { direta: 'bloqueada', respostaMs: null };

  const locais = bruto.candidatos.filter((c) => c.tipo === 'host').length;
  const publicas = new Set(srflx.map((c) => c.portaPublica)).size;
  const simetrico = locais > 0 && publicas > locais;
  return {
    direta: simetrico ? 'improvavel' : 'provavel',
    respostaMs: bruto.primeiraRespostaMs,
  };
}
