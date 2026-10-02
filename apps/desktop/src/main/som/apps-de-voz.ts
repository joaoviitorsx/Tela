/**
 * Quem é "a call" (D3): os apps de voz cujo som o modo Sistema deixa de fora.
 *
 * O modo Sistema leva tudo que toca no PC MENOS a call. Quem assiste costuma
 * estar na mesma call do Discord; mandar a call de volta faria cada um ouvir a
 * própria voz com atraso. Só o vídeo e o som do PC vão pelo Tela — a conversa
 * já tem o seu canal.
 *
 * Puro e pequeno de propósito: duas listas fechadas, sem heurística. Um nome
 * fora da lista é tratado como qualquer outro programa (vai junto), e a lista
 * cresce por pedido, não por adivinhação.
 */
import type { SessaoDeAudio } from './protocolo-utilitario.js';

/**
 * Windows: o nome do executável, sem `.exe` e sem caixa. O Discord vem
 * primeiro porque é o caso de uso do produto (e o process loopback só exclui
 * UMA árvore de processos por captura).
 */
const DISCORD_NO_WINDOWS: ReadonlySet<string> = new Set(['discord', 'discordptb', 'discordcanary', 'discorddevelopment']);
const OUTROS_DE_VOZ_NO_WINDOWS: ReadonlySet<string> = new Set([
  'ts3client_win64',
  'ts3client_win32',
  // TeamSpeak 5
  'teamspeak',
  // Teams novo e o clássico
  'ms-teams',
  'teams',
  'zoom',
  'skype',
  'mumble',
]);

/**
 * Linux: `application.name` ou `application.process.binary` do PipeWire, sem
 * caixa. O Discord nativo toca a call por um stream chamado "WEBRTC
 * VoiceEngine" (o motor de voz dele) com o binário `Discord`; os clientes
 * alternativos (Vesktop, WebCord…) se apresentam pelo próprio nome.
 */
const DE_VOZ_NO_LINUX: ReadonlySet<string> = new Set([
  'discord',
  'discord-ptb',
  'discordptb',
  'discord-canary',
  'discordcanary',
  'discord-development',
  'webrtc voiceengine',
  'vesktop',
  'webcord',
  'legcord',
  'armcord',
  'teamspeak',
  'teamspeak3',
  'teamspeak 3',
  'ts3client_linux_amd64',
  'ts3client_linux_x86',
  'mumble',
  'zoom',
  'skype',
  'skypeforlinux',
  'teams',
  'teams-for-linux',
  'ms-teams',
]);

const normalizar = (x: string): string => x.trim().toLowerCase();

/** Windows: `nome` é o executável sem extensão, como o addon o lista (`Discord`). */
export function ehAppDeVozNoWindows(nome: string): boolean {
  const n = normalizar(nome);
  return DISCORD_NO_WINDOWS.has(n) || OUTROS_DE_VOZ_NO_WINDOWS.has(n);
}

/** Linux: basta o nome OU o binário bater. */
export function ehAppDeVozNoLinux(nome: string | null, binario: string | null): boolean {
  return [nome, binario].some((x) => x !== null && DE_VOZ_NO_LINUX.has(normalizar(x)));
}

export type AlvoDaExclusao = {
  readonly pid: number;
  /** O executável excluído, para o log; `null` quando o alvo é o próprio Tela. */
  readonly app: string | null;
};

/**
 * Windows: de quem é a árvore de processos que o modo Sistema exclui. O
 * process loopback aceita UMA por captura:
 *
 *  1. o Discord, se estiver entre as sessões de áudio (tocando primeiro);
 *  2. senão, o primeiro outro app de voz (tocando primeiro);
 *  3. sem nenhum, o próprio Tela (`pidPrincipal`) — o resultado é "tudo
 *     menos o Tela", que é o mesmo que "tudo", sem a voz de ninguém.
 *
 * As sessões do próprio Tela nunca são candidatas.
 */
export function alvoDaExclusao(sessoes: readonly SessaoDeAudio[], pidsDoTela: ReadonlySet<number>, pidPrincipal: number): AlvoDaExclusao {
  const candidatas = sessoes
    .filter((s) => !pidsDoTela.has(s.pid) && ehAppDeVozNoWindows(s.nome))
    // `sort` é estável: entre iguais, a ordem da listagem decide.
    .sort((a, b) => peso(b) - peso(a));
  const escolhida = candidatas[0];
  return escolhida === undefined ? { pid: pidPrincipal, app: null } : { pid: escolhida.pid, app: escolhida.nome };
}

function peso(s: SessaoDeAudio): number {
  return (DISCORD_NO_WINDOWS.has(normalizar(s.nome)) ? 2 : 0) + (s.ativa ? 1 : 0);
}
