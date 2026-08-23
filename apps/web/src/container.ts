import { makeBrowserAudioCapture } from './adapters/browser-audio-capture.js';
import { makeBrowserScheduler } from './adapters/browser-scheduler.js';
import { makeBrowserScreenCapture } from './adapters/browser-screen-capture.js';
import { makeCryptoRandom } from './adapters/crypto-random.js';
import { makeFetchHttp } from './adapters/fetch-http.js';
import { makeLocalStorage } from './adapters/local-storage.js';
import { makeTransportFactory } from './adapters/transport-factory.js';
import { makeTelaApi } from './core/api/client.js';
import { makeIdentity } from './core/identity/owner-token.js';
import { BroadcastSession } from './core/media/broadcast-session.js';
import { ViewerSession } from './core/media/viewer-session.js';

/**
 * Raiz de composição do front. Equivalente ao composition.ts da API: é o único
 * lugar que conhece adapters concretos e os pluga nas portas de `core/`.
 *
 * Rotas e componentes recebem o que precisam daqui — nenhum deles importa
 * adapter, e nenhum deles sabe que LiveKit ou WebSocket existem.
 */
const storage = makeLocalStorage();
const random = makeCryptoRandom();
const http = makeFetchHttp();
const scheduler = makeBrowserScheduler();
const transports = makeTransportFactory();

export const api = makeTelaApi(http);
export const identity = makeIdentity(storage, random);
export const preferences = {
  key: 'tela.preset',
  read: () => storage.get('tela.preset'),
  write: (value: string) => storage.set('tela.preset', value),
};

export function createBroadcastSession(): BroadcastSession {
  return new BroadcastSession({
    api,
    transports,
    screen: makeBrowserScreenCapture(),
    audio: makeBrowserAudioCapture(),
    scheduler,
  });
}

export function createViewerSession(): ViewerSession {
  return new ViewerSession({ api, transports, scheduler });
}
