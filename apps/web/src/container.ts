import { OFFENSIVE, P2P_LIMITS, type PresetId, RESERVED, suggestPreset } from '@tela/shared';
import { makeAbrirNoApp } from './adapters/abrir-no-app.js';
import { makeBrowserAudioCapture } from './adapters/browser-audio-capture.js';
import { makeBrowserAudioGain } from './adapters/browser-audio-gain.js';
import { makeBrowserFrameTiming } from './adapters/browser-frame-timing.js';
import { makeBrowserPlatform } from './adapters/browser-platform.js';
import { makeBrowserScheduler } from './adapters/browser-scheduler.js';
import { makeBrowserScreenCapture } from './adapters/browser-screen-capture.js';
import { makeCryptoRandom } from './adapters/crypto-random.js';
import { makeLocalStorage } from './adapters/local-storage.js';
import { makeEncodeOnceTransport } from './adapters/encode-once-transport.js';
import { makeMeshTransport } from './adapters/mesh-transport.js';
import { codificaH264, requisitosAusentes, suportaUmEncode } from './adapters/suporte-um-encode.js';
import { CODEC } from './adapters/webcodecs-codificador.js';
import { makeCanvasQuadroNeutro } from './adapters/canvas-quadro-neutro.js';
import { makeBrowserSondaDeRede } from './adapters/browser-sonda-de-rede.js';
import { makeWebAudioCue } from './adapters/web-audio-cue.js';
import { suportaWebGL } from './adapters/webgl-probe.js';
import { makeWsSignaling } from './adapters/ws-signaling.js';
import { CHAVE_SEM_APP } from './core/domain/abrir-no-app.js';
import type { SlugPolicy } from './core/domain/slug.js';
import { linkDoCanal } from './core/domain/link.js';
import { makeIdentity } from './core/identity/owner-token.js';
import { makeAprovados } from './core/identity/aprovados.js';
import { makeEspectador } from './core/identity/espectador.js';
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
 *
 * O app desktop estende este arquivo (`desktop/container.desktop.ts`): as
 * dependências exportadas abaixo sem uso nas rotas existem para ele montar as
 * sessões com o MESMO storage, scheduler e identidade — sem duplicar nada.
 */
const storage = makeLocalStorage();
export const scheduler = makeBrowserScheduler();
const audioCapture = makeBrowserAudioCapture();
export const diagnosticId = (): string => crypto.randomUUID();
declare const __TELA_VERSION__: string | null;
export const appVersion = __TELA_VERSION__;

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
/** Quem assiste: chave do navegador e apelido (ADR 0025). */
export const espectador = makeEspectador(storage, makeCryptoRandom());
export const aprovados = makeAprovados(storage);

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

/**
 * "Abrir no app" na página do espectador (PLANO-desktop §14). A marca
 * `tela.semApp` é do aparelho, como o volume: "aqui não há app, não pergunte".
 */
export const abrirNoApp = makeAbrirNoApp();
export const semAppMarca = {
  ler: (): boolean => storage.get(CHAVE_SEM_APP) !== null,
  gravar: (): void => storage.set(CHAVE_SEM_APP, '1'),
  limpar: (): void => storage.remove(CHAVE_SEM_APP),
};

/** A web oferece o app desktop (BAIXAR APP); o próprio app sobrescreve com `false`. */
export const ofereceApp: boolean = true;

export const shareUrlFor = (slug: string): string => linkDoCanal(window.location.origin, slug);

/** Cada sessão recebe um transporte novo: canal reaberto não é canal reusado. */
function createTransport(): MediaTransport {
  return makeMeshTransport({ channel: makeWsSignaling(SIGNAL_URL), scheduler });
}

/**
 * Quem transmite: "um encode, N envios" (D0b) onde o navegador tem as peças,
 * mesh puro onde não tem.
 *
 * A escolha decide a CAPACIDADE, não só a CPU. O Chromium codifica uma vez
 * por `RTCPeerConnection` (medido no D0); com um encoder só, o custo por
 * espectador é banda, e cabem `P2P_LIMITS.maxViewers`. Sem ele, cada
 * espectador é mais um encoder 1080p60 disputando a GPU com o jogo, e o teto
 * continua sendo `maxViewersSemUmEncode`. O número declarado ao servidor sai
 * daqui; o diagnóstico mostra o mesmo, pelo mesmo motivo.
 */
const temAsPecas = suportaUmEncode(window);
/**
 * Sondagem do H.264 no `VideoEncoder`, uma vez, ao carregar: muito antes de
 * alguém apertar TRANSMITIR. `null` enquanto responde — aí vale a detecção
 * das peças, que é o caso comum.
 */
let h264: boolean | null = temAsPecas ? null : false;
if (temAsPecas) {
  void codificaH264((window as unknown as { VideoEncoder?: unknown }).VideoEncoder, CODEC).then((v) => {
    h264 = v;
  });
}

export function umEncode(): boolean {
  return temAsPecas && h264 !== false;
}
/** O que falta a este navegador para servir mais gente. Vazio quando serve. */
export function pecasAusentesDoUmEncode(): readonly string[] {
  const faltam: string[] = [...requisitosAusentes(window)];
  if (temAsPecas && h264 === false) faltam.push('H.264 no VideoEncoder');
  return faltam;
}
export function capacidadeDeEspectadores(): number {
  return umEncode() ? P2P_LIMITS.maxViewers : P2P_LIMITS.maxViewersSemUmEncode;
}

/**
 * O worker de injeção, por fábrica: o Vite só empacota o worker quando vê o
 * `new Worker(new URL(...), import.meta.url)` literal.
 */
const criarWorker = (): Worker =>
  new Worker(new URL('./adapters/injecao-worker.ts', import.meta.url), { type: 'module' });

function createTransportDoTransmissor(): MediaTransport {
  const channel = makeWsSignaling(SIGNAL_URL);
  return umEncode()
    ? makeEncodeOnceTransport({ channel, scheduler, criarWorker })
    : makeMeshTransport({ channel, scheduler });
}

export function createBroadcastSession(): BroadcastSession {
  return new BroadcastSession({
    transport: createTransportDoTransmissor(),
    capacidade: capacidadeDeEspectadores(),
    screen: makeBrowserScreenCapture(),
    audio: audioCapture,
    // Um grafo por sessão: `close()` desmonta, e reusar um contexto fechado
    // não tem volta.
    gain: makeBrowserAudioGain(),
    uplinkMemory,
    scheduler,
    shareUrlFor,
    aprovados,
    quadroNeutro: makeCanvasQuadroNeutro(),
    createStream: (tracks) => new MediaStream([...tracks]),
    diagnosticId,
    appVersion,
  });
}

export function createViewerSession(): ViewerSession {
  return new ViewerSession({ transport: createTransport, scheduler, diagnosticId, appVersion });
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
 * Se a abertura roda nesta visita à home. Na web, sempre (ADR 0013). O app
 * desktop sobrescreve: lá a home é uma tecla do trilho, e repetir a cena a
 * cada volta gasta GPU e engole o primeiro clique (o toque que pula a
 * abertura é barrado de propósito).
 */
export const aberturaPermitida = (): boolean => true;
/** A abertura terminou (ou foi pulada). Na web não muda nada. */
export const aberturaVista = (): void => undefined;

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

/** Teste de rede do diagnóstico, antes e durante a transmissão. */
export const sondaDeRede = makeBrowserSondaDeRede();
