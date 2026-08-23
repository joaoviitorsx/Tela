import { OFFENSIVE, RESERVED } from '@tela/shared';
import { makeBrowserAudioCapture } from './adapters/browser-audio-capture.js';
import { makeBrowserPlatform } from './adapters/browser-platform.js';
import { makeBrowserScheduler } from './adapters/browser-scheduler.js';
import { makeBrowserScreenCapture } from './adapters/browser-screen-capture.js';
import { makeCryptoRandom } from './adapters/crypto-random.js';
import { makeLocalStorage } from './adapters/local-storage.js';
import { makeMeshTransport } from './adapters/mesh-transport.js';
import { makeWsSignaling } from './adapters/ws-signaling.js';
import type { SlugPolicy } from './core/domain/slug.js';
import { makeIdentity } from './core/identity/owner-token.js';
import { BroadcastSession } from './core/media/broadcast-session.js';
import { ViewerSession } from './core/media/viewer-session.js';
import type { MediaTransport } from './core/ports/media-transport.js';

/**
 * Raiz de composição do front — único lugar que conhece adapters concretos.
 *
 * Depois do changeset 001 ele encolheu junto com a arquitetura: não há cliente
 * HTTP porque não há API, e o transporte é um só. Rotas e componentes recebem
 * o que precisam daqui; nenhum deles sabe que WebSocket ou WebRTC existem.
 */
const storage = makeLocalStorage();
const scheduler = makeBrowserScheduler();
const audioCapture = makeBrowserAudioCapture();

/** De onde vem o áudio do jogo depende do sistema. Ver `AudioSourcePicker`. */
export const platform = makeBrowserPlatform();
export const audio = audioCapture;

/**
 * Endereço do servidor de sinalização.
 *
 * Em produção o front é estático (Pages) e o signaling mora em outro host, daí
 * a variável de build. Em desenvolvimento o Vite faz proxy no mesmo origin.
 */
const SIGNAL_URL =
  import.meta.env['VITE_SIGNAL_URL'] ??
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/signal`;

export const identity = makeIdentity(storage, makeCryptoRandom());

export const policy: SlugPolicy = { reserved: RESERVED, offensive: OFFENSIVE };

export const preferences = {
  read: () => storage.get('tela.preset'),
  write: (value: string) => storage.set('tela.preset', value),
};

export const shareUrlFor = (slug: string): string =>
  `${window.location.origin}/${slug}`;

/** Cada sessão recebe um transporte novo: canal reaberto não é canal reusado. */
function createTransport(): MediaTransport {
  return makeMeshTransport({ channel: makeWsSignaling(SIGNAL_URL) });
}

export function createBroadcastSession(): BroadcastSession {
  return new BroadcastSession({
    transport: createTransport(),
    screen: makeBrowserScreenCapture(),
    audio: audioCapture,
    scheduler,
    shareUrlFor,
    createStream: (tracks) => new MediaStream([...tracks]),
  });
}

export function createViewerSession(): ViewerSession {
  return new ViewerSession({ transport: createTransport, scheduler });
}
