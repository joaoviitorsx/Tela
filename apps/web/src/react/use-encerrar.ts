import { useCallback, useState } from 'react';

/** "2 amigos estão assistindo agora e vão perder a imagem." Singular e plural certos. */
export function textoDeEncerrar(espectadores: number): string {
  return espectadores === 1
    ? '1 amigo está assistindo agora e vai perder a imagem.'
    : `${espectadores} amigos estão assistindo agora e vão perder a imagem.`;
}

/**
 * ENCERRAR com confirmação só quando há quem perder (C-03). Sozinho, um clique
 * encerra: perguntar a quem não tem plateia é atrito, e a tela de fim já
 * oferece TRANSMITIR DE NOVO.
 */
export function useEncerrar(
  espectadores: number,
  encerrar: () => void,
): {
  readonly confirmando: boolean;
  readonly pedir: () => void;
  readonly confirmar: () => void;
  readonly cancelar: () => void;
  readonly texto: string;
} {
  const [confirmando, setConfirmando] = useState(false);

  const pedir = useCallback(() => {
    if (espectadores > 0) setConfirmando(true);
    else encerrar();
  }, [espectadores, encerrar]);

  const confirmar = useCallback(() => {
    setConfirmando(false);
    encerrar();
  }, [encerrar]);

  const cancelar = useCallback(() => setConfirmando(false), []);

  return { confirmando, pedir, confirmar, cancelar, texto: textoDeEncerrar(espectadores) };
}
