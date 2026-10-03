import { OFFENSIVE, RESERVED } from '@tela/shared';
import { makeAbrirNoApp } from './adapters/abrir-no-app.js';
import { makeBrowserFrameTiming } from './adapters/browser-frame-timing.js';
import { makeBrowserScheduler } from './adapters/browser-scheduler.js';
import { makeCryptoRandom } from './adapters/crypto-random.js';
import { makeDiscordWebhook } from './adapters/discord-webhook.js';
import { makeLocalStorage } from './adapters/local-storage.js';
import { makeAceitaCodec } from './adapters/decodificacao-av1.js';
import { makeMeshTransport } from './adapters/mesh-transport.js';
import { makeWebAudioCue } from './adapters/web-audio-cue.js';
import { suportaWebGL } from './adapters/webgl-probe.js';
import { makeWsSignaling } from './adapters/ws-signaling.js';
import { CHAVE_SEM_APP } from './core/domain/abrir-no-app.js';
import type { SlugPolicy } from './core/domain/slug.js';
import { linkDoCanal } from './core/domain/link.js';
import { makeIdentity } from './core/identity/owner-token.js';
import { makeEspectador } from './core/identity/espectador.js';
import { makeCanaisRecentes } from './core/identity/canais-recentes.js';
import { AvisoAoVivo } from './core/aviso/aviso-ao-vivo.js';
import { makePreferenciaDaPip } from './core/multivisao/preferencia-da-pip.js';
import { ViewerSession } from './core/media/viewer-session.js';
import type { AbreVitrine } from './core/ports/crt-vitrine.js';
import type { AbrePalco } from './core/ports/intro-stage.js';

/**
 * Raiz de composição do front — único lugar que conhece adapters concretos.
 *
 * Depois do changeset 001 ele encolheu junto com a arquitetura: não há cliente
 * HTTP porque não há API, e o transporte é um só. Rotas e componentes recebem
 * o que precisam daqui; nenhum deles sabe que WebSocket ou WebRTC existem.
 *
 * Este é o container do ESPECTADOR e do que é comum: o que só quem transmite
 * usa mora em `container-transmissao.ts`, para o espectador não baixá-lo.
 *
 * O app desktop estende os dois (`desktop/container.desktop.ts`): as
 * dependências exportadas abaixo sem uso nas rotas existem para ele montar as
 * sessões com o MESMO storage, scheduler e identidade — sem duplicar nada.
 */
export const storage = makeLocalStorage();
export const scheduler = makeBrowserScheduler();
export const diagnosticId = (): string => crypto.randomUUID();
declare const __TELA_VERSION__: string | null;
export const appVersion = __TELA_VERSION__;

/**
 * A medição de latência por quadro precisa do `<video>`, que só existe em
 * tempo de render — então o container exporta a FÁBRICA, não a instância.
 *
 * É o mesmo motivo de `createViewerSession` ser função: a fiação passa por
 * aqui, mas o objeto nasce quando quem usa tem o que ele precisa.
 */
export const frameTimingDe = makeBrowserFrameTiming;

/**
 * Endereço do servidor de sinalização.
 *
 * Em produção o front é estático (Pages) e o signaling mora em outro host, daí
 * a variável de build. Em desenvolvimento o Vite faz proxy no mesmo origin.
 */
export const signalUrl: string =
  import.meta.env['VITE_SIGNAL_URL'] ??
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/signal`;

export const identity = makeIdentity(storage, makeCryptoRandom());
/** Quem assiste: chave do navegador e apelido (ADR 0025). */
export const espectador = makeEspectador(storage, makeCryptoRandom());

export const policy: SlugPolicy = { reserved: RESERVED, offensive: OFFENSIVE };

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

/**
 * Esta página roda dentro do app desktop (D-04). A moldura do app já tem
 * trilho (TRANSMITIR, ASSISTIR, CÓDIGO, DIAG, AJUSTES) e painel NO AR: o
 * cabeçalho do site repetiria a marca e os botões, então as rotas o omitem.
 */
export const dentroDoApp: boolean = false;

/** Pré-lançamento não aparece em `/releases/latest`: o link é a página de lançamentos. */
export const urlDosLancamentos = 'https://github.com/joaoviitorsx/Tela/releases';

/**
 * Instalar o app do Discord na própria conta (docs/DISCORD.md §2): depois
 * disso, `/tela canal:<nome>` em qualquer conversa. O Application ID é
 * público. Quem hospeda o próprio Tela registra o próprio app e troca o ID —
 * ou põe `null`, e o botão DISCORD some do console.
 */
const DISCORD_APPLICATION_ID: string | null = '1545598563994701824';
export const instalarNoDiscord: string | null =
  DISCORD_APPLICATION_ID === null ? null : `https://discord.com/oauth2/authorize?client_id=${DISCORD_APPLICATION_ID}`;

export const shareUrlFor = (slug: string): string => linkDoCanal(window.location.origin, slug);

/**
 * O aviso automático no Discord (webhook de canal): AO VIVO ao subir,
 * "encerrada" ao acabar. Mora aqui, e não na rota, porque sobrevive à troca
 * de tela e ao fechamento da aba (a edição final vai com `keepalive`).
 */
export const avisoNoDiscord = new AvisoAoVivo({ porta: makeDiscordWebhook(), storage, agora: () => Date.now() });

/**
 * O worker do repassador (ADR 0031): o mesmo de injeção, em outro papel. Só
 * nasce se este espectador for escolhido para repassar.
 */
const criarWorkerDeRepasse = (): Worker =>
  new Worker(new URL('./adapters/injecao-worker.ts', import.meta.url), { type: 'module' });

/**
 * Liga a cascata sem esperar a malha apertar. Só o teste de ponta a ponta usa:
 * com três navegadores num loopback a malha nunca aperta.
 */
export function repasseForcado(): boolean {
  try {
    return localStorage.getItem('tela.repasse') === 'forcar';
  } catch {
    return false;
  }
}

/**
 * AV1 por SOFTWARE no codificador único (ADR 0035). Só o teste de ponta a
 * ponta usa: em produção o AV1 exige encoder de hardware, porque por software
 * a 1080p60 pesaria no jogo.
 */
export function av1Forcado(): boolean {
  try {
    return localStorage.getItem('tela.av1') === 'forcar';
  } catch {
    return false;
  }
}

/**
 * Cada tentativa recebe um transporte novo: canal reaberto não é canal reusado.
 *
 * `repassar`: perguntado a cada conexão nova. Na multivisão a resposta é não
 * (ADR 0032): a recepção dividida entre dois canais é frágil demais para
 * segurar filhos da cascata.
 */
/** O que este aparelho recusa receber (ADR 0035): AV1 sem decoder eficiente. */
export const aceitaCodec = makeAceitaCodec(av1Forcado());

export function createViewerSession({ repassar = () => true }: OpcoesDoEspectador = {}): ViewerSession {
  return new ViewerSession({
    transport: () =>
      makeMeshTransport({
        channel: makeWsSignaling(signalUrl),
        scheduler,
        aceitaCodec,
        ...(repassar() ? { repasse: { espectador: { criarWorker: criarWorkerDeRepasse } } } : {}),
      }),
    scheduler,
    diagnosticId,
    appVersion,
  });
}

export type OpcoesDoEspectador = { readonly repassar?: () => boolean };

/** Os canais que este aparelho assistiu, para o `+ TELA` (ADR 0032). */
export const canaisRecentes = makeCanaisRecentes(storage);

/** Canto e tamanho do quadro da multivisão, lembrados no aparelho. */
export const preferenciaDaPip = makePreferenciaDaPip(storage);

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
