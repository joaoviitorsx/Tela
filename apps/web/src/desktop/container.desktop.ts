import { P2P_LIMITS } from '@tela/shared';
import { makeBrowserAudioGain } from '../adapters/browser-audio-gain.js';
import { makeBrowserScreenCapture } from '../adapters/browser-screen-capture.js';
import { makeCanvasQuadroNeutro } from '../adapters/canvas-quadro-neutro.js';
import { CodificadorExterno } from '../adapters/codificador-externo.js';
import type { CodificadorUnico, DepsDoCodificador } from '../adapters/codificador-unico.js';
import { makeEncodeOnceTransport } from '../adapters/encode-once-transport.js';
import { makeMeshTransport } from '../adapters/mesh-transport.js';
import { CodificadorWebCodecs } from '../adapters/webcodecs-codificador.js';
import { makeWsSignaling } from '../adapters/ws-signaling.js';
import { appVersion, aprovados, audio, diagnosticId, scheduler, uplinkMemory } from '../container.js';
import { linkDoCanal } from '../core/domain/link.js';
import { BroadcastSession } from '../core/media/broadcast-session.js';
import { ViewerSession } from '../core/media/viewer-session.js';
import type { MediaTransport } from '../core/ports/media-transport.js';
import type { ScreenCapture } from '../core/ports/screen-capture.js';
import { makeCapturaDesktop } from './captura-desktop.js';
import { CodificadorComutavel } from './codificador-comutavel.js';
import { makeLigacaoNativa } from './porta-nativa.js';
import { makeSeletorDeFontes } from './seletor-de-fontes.js';
import { criarTrilhaFantasma } from './trilha-fantasma.js';

/**
 * A raiz de composição do app desktop (PLANO-desktop §3.6).
 *
 * Estende a da web: tudo que não muda vem de lá, pelo `export *`, com o MESMO
 * storage, identidade e scheduler — as chaves do `localStorage` são as mesmas
 * e o código de recuperação importado em `/recuperar` cai na mesma identidade.
 * O que muda, e é exportado abaixo por cima do `export *`:
 *
 * - o link compartilhado é a origem PÚBLICA, nunca `app://` (§3.5);
 * - o signaling é o configurado no build, porque `app://tela` não tem `/signal`;
 * - o transporte de quem transmite é o "um encode, N envios" (D0b): um
 *   codificador para todos os espectadores, não um por `RTCPeerConnection`;
 * - a captura é a do app (D2): seletor próprio, portal, ou o `tela-captura`
 *   nativo com NVENC — e o codificador acompanha a captura
 *   (`codificador-comutavel.ts`).
 *
 * O plugin em `vite.desktop.config.ts` faz rotas e hooks lerem este arquivo
 * quando importam `../container.js`.
 */
export * from '../container.js';

/** Em dev o app roda em `http://localhost:5174`; aí a própria origem serve. */
function origemHttp(): string | null {
  const { protocol, origin } = window.location;
  return protocol === 'http:' || protocol === 'https:' ? origin : null;
}

const ORIGEM_PUBLICA = import.meta.env['VITE_PUBLIC_ORIGIN'] ?? origemHttp();
if (ORIGEM_PUBLICA === null) {
  console.error('Build do desktop sem VITE_PUBLIC_ORIGIN: o app não tem link para compartilhar.');
}

/**
 * A abertura roda uma vez por sessão do app: na abertura do programa, não a
 * cada volta à home pelo trilho. Marca ao TERMINAR, não ao começar — o
 * StrictMode do desenvolvimento monta o efeito duas vezes.
 */
let aberturaJaVista = false;
export const aberturaPermitida = (): boolean => !aberturaJaVista;
export const aberturaVista = (): void => {
  aberturaJaVista = true;
};

/** Dentro do app, BAIXAR APP não faz sentido. */
export const ofereceApp: boolean = false;

export const shareUrlFor = (slug: string): string => {
  // Bug de build, não erro esperado (R4): sem origem pública não há link que
  // preste, e inventar um `app://` mandaria os amigos para lugar nenhum.
  if (ORIGEM_PUBLICA === null) throw new Error('VITE_PUBLIC_ORIGIN ausente no build do desktop');
  return linkDoCanal(ORIGEM_PUBLICA, slug);
};

const SIGNAL_URL: string | null =
  import.meta.env['VITE_SIGNAL_URL'] ??
  (origemHttp() === null
    ? null
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/signal`);

function signaling() {
  if (SIGNAL_URL === null) throw new Error('VITE_SIGNAL_URL ausente no build do desktop');
  return makeWsSignaling(SIGNAL_URL);
}

/**
 * O worker de injeção, por fábrica: o Vite só empacota o worker quando vê o
 * `new Worker(new URL(...), import.meta.url)` literal.
 */
const criarWorker = (): Worker =>
  new Worker(new URL('../adapters/injecao-worker.ts', import.meta.url), { type: 'module' });

/*
  A captura (D2). Em dev no navegador (`http://localhost:5174`, sem Electron)
  não há ponte: o seletor é o do navegador e o codificador é o WebCodecs, como
  na web — o app inteiro continua utilizável para mexer na interface.
*/
const ponte = window.telaDesktop;

const agendar = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/** A loja do seletor próprio: a moldura desenha, o adapter de captura abre. */
export const seletorDeFontes = makeSeletorDeFontes({
  listar: () => ponte?.listarFontes() ?? Promise.resolve([]),
  agendar,
});

const ligacaoNativa = makeLigacaoNativa(window);

const capturaDesktop =
  ponte === undefined
    ? null
    : makeCapturaDesktop({
        ponte,
        seletor: seletorDeFontes,
        navegador: makeBrowserScreenCapture(),
        ligacao: ligacaoNativa,
        criarTrilhaFantasma,
      });

const screen: ScreenCapture = capturaDesktop ?? makeBrowserScreenCapture();

/**
 * O codificador do "um encode": no app, um que escolhe entre o externo
 * (NVENC, quando a captura é a nativa) e o WebCodecs. O externo fala com o
 * `tela-captura` pela ligação acima, que o adapter de captura liga à porta
 * da sessão quando ela sobe.
 */
function criarCodificador(d: DepsDoCodificador): CodificadorUnico {
  if (capturaDesktop === null) {
    return new CodificadorWebCodecs(d.entregar, () => performance.now(), d.aoCapturar);
  }
  return new CodificadorComutavel<CodificadorUnico>({
    nativo: () => new CodificadorExterno(ligacaoNativa.porta, d),
    webcodecs: () => new CodificadorWebCodecs(d.entregar, () => performance.now(), d.aoCapturar),
    ehNativa: (track) => capturaDesktop.ehNativa(track),
  });
}

function createTransport(): MediaTransport {
  return makeEncodeOnceTransport({ channel: signaling(), scheduler, criarWorker, criarCodificador });
}

/**
 * O app SEMPRE transmite com um encoder só — o Chromium embarcado tem as três
 * peças —, então serve o teto do produto. A web decide isto por detecção.
 */
export const umEncode = (): boolean => true;
export const pecasAusentesDoUmEncode = (): readonly string[] => [];
export const capacidadeDeEspectadores = (): number => P2P_LIMITS.maxViewers;

export function createBroadcastSession(): BroadcastSession {
  return new BroadcastSession({
    transport: createTransport(),
    capacidade: capacidadeDeEspectadores(),
    screen,
    audio,
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
  return new ViewerSession({
    transport: () => makeMeshTransport({ channel: signaling(), scheduler }),
    scheduler,
    diagnosticId,
    appVersion,
  });
}
