import type { TransportFactory } from '../core/ports/media-transport.js';
import { makeP2pPublisherTransport, makeP2pViewerTransport } from './p2p-transport.js';

/**
 * Escolhe o transporte pelo campo que a API devolveu.
 *
 * O cliente não decide topologia — o servidor decide, e o cliente obedece.
 * Isso significa que trocar um deploy inteiro de SFU para P2P é uma variável
 * de ambiente na API; nenhum usuário precisa atualizar nada.
 */
export function makeTransportFactory(): TransportFactory {
  /**
   * `import()` dinâmico: o `livekit-client` é ~600KB e vira um chunk separado.
   * Uma instalação em modo P2P nunca o baixa — e P2P é justamente o modo de
   * quem está hospedando em casa, possivelmente servindo pelo próprio link.
   */
  const livekit = () => import('./livekit-transport.js');

  return {
    async publisher(kind) {
      if (kind === 'p2p') return makeP2pPublisherTransport();
      return (await livekit()).makeLiveKitPublisherTransport();
    },
    async viewer(kind) {
      if (kind === 'p2p') return makeP2pViewerTransport();
      return (await livekit()).makeLiveKitViewerTransport();
    },
  };
}
