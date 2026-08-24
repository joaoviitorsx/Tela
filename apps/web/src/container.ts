import { OFFENSIVE, RESERVED, suggestPreset } from '@tela/shared';
import { makeBrowserAudioCapture } from './adapters/browser-audio-capture.js';
import { makeBrowserAudioGain } from './adapters/browser-audio-gain.js';
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

/**
 * Banda que o link deste aparelho sustentou, por espectador, medida pelo
 * próprio WebRTC na última transmissão.
 *
 * É a única fonte de medição real que existe: não dá para medir upload antes
 * de conectar, e pedir o número ao usuário contradiz "aperta um botão".
 */
export const uplinkMemory = {
  read: () => storage.get('tela.uplink'),
  write: (value: string) => storage.set('tela.uplink', value),
};

export const preferences = {
  /**
   * Escolha explícita vence sempre. Sem escolha, sugere pela banda lembrada
   * em vez de abrir em 1080p60 num link que não aguenta — a captura é fixada
   * no início e nenhum teto de bitrate desfaz resolução alta demais.
   */
  read: () => {
    const escolhido = storage.get('tela.preset');
    if (escolhido !== null) return escolhido;
    const lembrado = Number(uplinkMemory.read() ?? '');
    if (!Number.isFinite(lembrado) || lembrado <= 0) return null;
    return suggestPreset(lembrado, 1);
  },
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
    // Um grafo por sessão: `close()` desmonta, e reusar um contexto fechado
    // não tem volta.
    gain: makeBrowserAudioGain(),
    uplinkMemory,
    scheduler,
    shareUrlFor,
    createStream: (tracks) => new MediaStream([...tracks]),
  });
}

export function createViewerSession(): ViewerSession {
  return new ViewerSession({ transport: createTransport, scheduler });
}

/**
 * Volume do espectador.
 *
 * Preferência de aparelho, não de conta: quem assiste não tem token nenhum e
 * mesmo assim espera que o volume de ontem continue valendo hoje. O estado
 * "mudo" NÃO é persistido — ver `use-volume.ts`.
 */
export const volumePreference = {
  read: () => storage.get('tela.volume'),
  write: (value: string) => storage.set('tela.volume', value),
};

/** Volume DA TRANSMISSÃO, do lado de quem transmite. Outro controle, outra chave. */
export const volumeTransmissaoPreference = {
  read: () => storage.get('tela.volume-transmissao'),
  write: (value: string) => storage.set('tela.volume-transmissao', value),
};
