import { useSyncExternalStore } from 'react';
import { useDiagnosticoAberto } from '../react/painel-diagnostico.js';
import { ModalDiagnosticoPreAr } from '../routes/ModalDiagnosticoPreAr.js';
import { type SessaoAoVivo, sessaoAoVivo } from './sessao-ao-vivo.js';

type Props = { readonly sessao?: SessaoAoVivo };

/**
 * O DIAGNÓSTICO do trilho (D-04) fora do ar: o mesmo painel "REDE E CONEXÕES"
 * que o site abre no cabeçalho da home.
 *
 * Ao vivo ele é da rota de transmissão, que tem os números reais; aqui só
 * monta quando NÃO há transmissão no ar, para o painel não abrir duas vezes.
 */
export function DiagnosticoDoApp({ sessao = sessaoAoVivo }: Props) {
  const { aberto, fechar } = useDiagnosticoAberto();
  const noAr = useSyncExternalStore(sessao.assinar, () => sessao.instantaneo().state.status === 'live');
  return <ModalDiagnosticoPreAr aberto={aberto && !noAr} aoFechar={fechar} />;
}
