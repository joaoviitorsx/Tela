import { useCallback, useState } from 'react';
import { audio } from '../container.js';
import type { AudioDevice } from '../core/ports/audio-capture.js';

/**
 * Lista de entradas de áudio, sob demanda.
 *
 * Não busca sozinho no mount de propósito: listar exige pedir permissão de
 * microfone, e um pedido de permissão que aparece sem o usuário ter clicado
 * em nada é o tipo de coisa que faz a pessoa fechar a aba.
 */
export function useAudioSources(): {
  devices: readonly AudioDevice[];
  buscando: boolean;
  procurar: () => void;
} {
  const [devices, setDevices] = useState<readonly AudioDevice[]>([]);
  const [buscando, setBuscando] = useState(false);

  const procurar = useCallback(() => {
    setBuscando(true);
    void (async () => {
      try {
        await audio.requestPermission();
        setDevices(await audio.listMonitors());
      } finally {
        setBuscando(false);
      }
    })();
  }, []);

  return { devices, buscando, procurar };
}
