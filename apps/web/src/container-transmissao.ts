import { P2P_LIMITS, type PresetId, suggestPreset } from '@tela/shared';
import { makeBrowserAudioCapture } from './adapters/browser-audio-capture.js';
import { makeBrowserAudioGain } from './adapters/browser-audio-gain.js';
import { makeBrowserPlatform } from './adapters/browser-platform.js';
import { makeBrowserScreenCapture } from './adapters/browser-screen-capture.js';
import { makeBrowserSondaDeRede } from './adapters/browser-sonda-de-rede.js';
import { makeCanvasQuadroNeutro } from './adapters/canvas-quadro-neutro.js';
import { makeEncodeOnceTransport } from './adapters/encode-once-transport.js';
import { makeMeshTransport } from './adapters/mesh-transport.js';
import { codificaH264, requisitosAusentes, suportaUmEncode } from './adapters/suporte-um-encode.js';
import { CODEC } from './adapters/webcodecs-codificador.js';
import { makeWsSignaling } from './adapters/ws-signaling.js';
import { appVersion, av1Forcado, diagnosticId, repasseForcado, scheduler, shareUrlFor, signalUrl, storage } from './container.js';
import { CodificadorWebCodecs } from './adapters/webcodecs-codificador.js';
import type { DepsDoCodificador } from './adapters/codificador-unico.js';
import { makeAprovados } from './core/identity/aprovados.js';
import { BroadcastSession } from './core/media/broadcast-session.js';
import type { MediaTransport } from './core/ports/media-transport.js';
import type { SomDoApp } from './react/som-do-app.js';

/**
 * Raiz de composição de quem TRANSMITE — a metade do front que o espectador
 * nunca baixa.
 *
 * Fica separada de `container.ts` para o bundler poder cortar: o espectador
 * abre `/<canal>` e carrega o container compartilhado, sem `BroadcastSession`,
 * sem o "um encode", sem captura e sem a sondagem de H.264. Só a home e a rota
 * de transmissão importam este arquivo. O app desktop redireciona os dois
 * containers para `desktop/container.desktop.ts` (`troca-de-container.ts`).
 */
const audioCapture = makeBrowserAudioCapture();
export const audio = audioCapture;
export const aprovados = makeAprovados(storage);

/**
 * O passo ÁUDIO do app desktop (D3): três opções e o modo real. `null` na web,
 * onde a home desenha o `AudioSourcePicker` do navegador; o container do
 * desktop sobrescreve.
 */
export const somDoApp: SomDoApp | null = null;

/** De onde vem o áudio do jogo depende do sistema. Ver `AudioSourcePicker`. */
export const platform = makeBrowserPlatform();

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
  const channel = makeWsSignaling(signalUrl);
  return umEncode()
    ? makeEncodeOnceTransport({
        channel,
        scheduler,
        criarWorker,
        forcarRepasse: repasseForcado(),
        ...(av1Forcado()
          ? {
              criarCodificador: (d: DepsDoCodificador) =>
                new CodificadorWebCodecs(d.entregar, () => performance.now(), d.aoCapturar, { av1: 'forcado' }),
            }
          : {}),
      })
    : makeMeshTransport({ channel, scheduler });
}

/** Este navegador sabe capturar a tela? Celular quase nunca: a home avisa antes dos passos. */
export const capturaSuportada = (): boolean => makeBrowserScreenCapture().isSupported();

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

/** Volume DA TRANSMISSÃO, do lado de quem transmite. Outro controle, outra chave. */
export const volumeTransmissaoPreference = {
  read: () => storage.get('tela.volume-transmissao'),
  write: (value: string) => storage.set('tela.volume-transmissao', value),
};

/** Teste de rede do diagnóstico, antes e durante a transmissão. */
export const sondaDeRede = makeBrowserSondaDeRede();
