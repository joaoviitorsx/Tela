import { useCallback, useEffect, useRef, useState } from 'react';
import { canalDaEntrada } from '../core/domain/entrada-de-canal.js';
import { type Dialogo, useDialogo } from '../react/use-dialogo.js';

export type Assistir = {
  readonly aberto: boolean;
  readonly valor: string;
  readonly invalido: boolean;
  readonly dialogo: Dialogo;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly abrir: () => void;
  readonly fechar: () => void;
  readonly mudar: (valor: string) => void;
  readonly enviar: () => void;
};

/**
 * O painel ASSISTIR: abre, valida o que foi colado e leva à rota do espectador.
 *
 * `irPara` é o da moldura (`useNavegacaoDesktop`), que já recusa navegar ao
 * vivo — a tecla do trilho nem responde nesse estado, mas a recusa fica aqui
 * também, de graça, porque é o mesmo caminho.
 */
export function useAssistir(irPara: (caminho: string) => void): Assistir {
  const [aberto, setAberto] = useState(false);
  const [valor, setValor] = useState('');
  const [invalido, setInvalido] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const fechar = useCallback(() => setAberto(false), []);
  const dialogo = useDialogo(aberto, fechar);

  useEffect(() => {
    // Depois do `showModal` do `useDialogo` (efeito anterior, mesmo commit).
    if (aberto) inputRef.current?.focus();
  }, [aberto]);

  const abrir = useCallback(() => {
    setValor('');
    setInvalido(false);
    setAberto(true);
  }, []);

  const mudar = useCallback((v: string) => {
    setValor(v);
    setInvalido(false);
  }, []);

  const enviar = useCallback(() => {
    const canal = canalDaEntrada(valor);
    if (!canal.ok) {
      setInvalido(true);
      return;
    }
    setAberto(false);
    irPara(`/${canal.value}`);
  }, [valor, irPara]);

  return { aberto, valor, invalido, dialogo, inputRef, abrir, fechar, mudar, enviar };
}
