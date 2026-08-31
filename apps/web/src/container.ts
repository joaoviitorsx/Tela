import { OFFENSIVE, type PresetId, RESERVED, suggestPreset } from '@tela/shared';
import { makeBrowserAudioCapture } from './adapters/browser-audio-capture.js';
import { makeBrowserAudioGain } from './adapters/browser-audio-gain.js';
import { makeBrowserFrameTiming } from './adapters/browser-frame-timing.js';
import { makeBrowserPlatform } from './adapters/browser-platform.js';
import { makeBrowserScheduler } from './adapters/browser-scheduler.js';
import { makeBrowserScreenCapture } from './adapters/browser-screen-capture.js';
import { makeCryptoRandom } from './adapters/crypto-random.js';
import { makeLocalStorage } from './adapters/local-storage.js';
import { makeMeshTransport } from './adapters/mesh-transport.js';
import { makeWebAudioCue } from './adapters/web-audio-cue.js';
import { suportaWebGL } from './adapters/webgl-probe.js';
import { makeWsSignaling } from './adapters/ws-signaling.js';
import type { SlugPolicy } from './core/domain/slug.js';
import { makeIdentity } from './core/identity/owner-token.js';
import { BroadcastSession } from './core/media/broadcast-session.js';
import { ViewerSession } from './core/media/viewer-session.js';
import type { AbreVitrine } from './core/ports/crt-vitrine.js';
import type { AbrePalco } from './core/ports/intro-stage.js';
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

/**
 * A medição de latência por quadro precisa do `<video>`, que só existe em
 * tempo de render — então o container exporta a FÁBRICA, não a instância.
 *
 * É o mesmo motivo de `createViewerSession` ser função: a fiação passa por
 * aqui, mas o objeto nasce quando quem usa tem o que ele precisa.
 */
export const frameTimingDe = makeBrowserFrameTiming;
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

/**
 * O melhor degrau que o link MEDIDO na última transmissão sustentou.
 *
 * Separado da preferência de preset de propósito: aquela é o que o usuário
 * ESCOLHEU, esta é o que o link PAGOU. Desde a ADR 0015 as duas podem divergir
 * — pedir 1080p60 num link de 10 Mbps entrega 576p60 — e o seletor precisa das
 * duas para parar de fingir que o rótulo é o resultado.
 *
 * `null` na primeira transmissão do aparelho, quando ainda não há medição.
 */
export function presetSustentavel(): PresetId | null {
  const lembrado = Number(uplinkMemory.read() ?? '');
  if (!Number.isFinite(lembrado) || lembrado <= 0) return null;
  return suggestPreset(lembrado, 1);
}

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

/**
 * A abertura (`core/intro/`, `adapters/three-crt-stage.ts`).
 *
 * O `import()` é dinâmico de propósito: o three.js é ~150 KB comprimidos, e a
 * página que ele decora é um campo e um botão. Assim ele vira um pedaço à
 * parte, baixado só quando a sondagem já decidiu que a abertura vai rodar — ou
 * seja, nunca na segunda visita, que é a maioria das visitas.
 */
export const abrirPalcoAbertura: AbrePalco = async (opcoes) => {
  const { abrirPalco } = await import('./adapters/three-crt-stage.js');
  return abrirPalco(opcoes);
};

export const suporteDeAbertura = suportaWebGL;

/**
 * O aparelho da vitrine, ao lado do campo.
 *
 * Mesmo `import()` dinâmico da abertura, e de propósito: as duas cenas caem no
 * mesmo pedaço do bundle. Quem chega na tela inicial baixa o three.js uma vez e
 * as duas usam — e quem nunca chega nela (o espectador, que abre `/slug`) não
 * baixa nada.
 */
export const abrirVitrineCrt: AbreVitrine = async (opcoes) => {
  const { abrirVitrine } = await import('./adapters/three-crt-vitrine.js');
  return abrirVitrine(opcoes);
};

/** O chiado do §10. Mudo global persistido; a abertura em si é sempre muda. */
export const audioCue = makeWebAudioCue(storage);
