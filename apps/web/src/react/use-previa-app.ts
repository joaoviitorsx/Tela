import { useCallback, useMemo, useState } from 'react';
import type { LinhaMenu } from '../components/MenuOsd.js';

type Opcao = {
  readonly id: string;
  readonly rotulo: string;
  readonly valores: readonly string[];
  readonly ajuda: string;
};

/**
 * As opções do app desktop, como PRÉVIA (o app ainda não existe).
 *
 * O texto de cada uma diz o que é planejado, não o que está pronto: o plano
 * (§20) proíbe anunciar captura só do jogo ou segundo plano sem prova em
 * Windows e Linux. Mexer aqui não guarda nada.
 */
const OPCOES: readonly Opcao[] = [
  { id: 'boot', rotulo: 'INICIAR COM O SISTEMA', valores: ['LIGADO', 'DESLIGADO'], ajuda: 'No beta: abre escondido na bandeja quando o computador liga, sem capturar nada.' },
  { id: 'bg', rotulo: 'FECHAR = SEGUNDO PLANO', valores: ['LIGADO', 'DESLIGADO'], ajuda: 'No beta: o X da janela esconde o Tela na bandeja (ou no modo compacto) em vez de encerrar a transmissão.' },
  { id: 'cap', rotulo: 'CAPTURA', valores: ['JANELA DO JOGO', 'TELA INTEIRA'], ajuda: 'No beta: seletor próprio com miniaturas de janelas e telas no Windows; no Linux, o portal do sistema lembra a escolha.' },
  { id: 'aa', rotulo: 'ÁUDIO', valores: ['SÓ DO JOGO', 'SISTEMA TODO'], ajuda: 'Planejado: deixar o Discord e a música de fora. Depende de testes em Windows e Linux.' },
  { id: 'hot', rotulo: 'ATALHO NO AR', valores: ['CTRL+SHIFT+T', 'CTRL+ALT+L', 'F10'], ajuda: 'Planejado: ligar e desligar a transmissão de dentro do jogo, sem alt-tab.' },
];

export const IDS_PREVIA_APP = OPCOES.map((o) => o.id);

export function usePreviaApp(): {
  readonly linhas: readonly LinhaMenu[];
  readonly ajustar: (id: string, direcao: -1 | 1) => void;
} {
  const [escolhas, setEscolhas] = useState<Record<string, number>>({});

  const ajustar = useCallback((id: string, direcao: -1 | 1) => {
    const opcao = OPCOES.find((o) => o.id === id);
    if (opcao === undefined) return;
    setEscolhas((atual) => {
      const n = opcao.valores.length;
      return { ...atual, [id]: ((atual[id] ?? 0) + direcao + n) % n };
    });
  }, []);

  const linhas = useMemo(
    () =>
      OPCOES.map((o): LinhaMenu => {
        const indice = escolhas[o.id] ?? 0;
        return {
          id: o.id,
          tipo: 'ciclo',
          rotulo: o.rotulo,
          valor: o.valores[indice] ?? '',
          indice,
          total: o.valores.length,
          ajuda: o.ajuda,
        };
      }),
    [escolhas],
  );

  return { linhas, ajustar };
}
