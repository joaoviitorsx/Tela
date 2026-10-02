/**
 * O protocolo entre o main e o utility process do som do jogo no Windows (D3).
 *
 * Duas conversas separadas, de propósito:
 *
 *  - **controle** (`parentPort`, este arquivo): pedidos e respostas curtas,
 *    objetos JSON. Valida-se dos dois lados — um utility que cai ou um addon
 *    que devolve lixo não pode virar `undefined.pid` no main;
 *  - **PCM** (uma `MessagePort` que o main só REPASSA ao renderer): blocos de
 *    10 ms de float32 intercalado. O main nunca vê esses bytes — o caminho do
 *    áudio é addon → utility → renderer, sem tocar no processo principal.
 *
 * O pedido `capturar` leva a porta do PCM em `ports[0]` (transferência do
 * Electron); por isso a forma abaixo não a menciona.
 */

/** O formato fixo do PCM: o que o addon pede ao WASAPI e o que o worklet espera. */
export const TAXA_DE_AMOSTRAGEM = 48_000;
export const CANAIS_DO_PCM = 2;
/** 10 ms por bloco: a latência que o main-thread do renderer pode atrasar sem o som estalar é o anel (60 ms). */
export const QUADROS_POR_BLOCO = 480;

export type SessaoDeAudio = {
  readonly pid: number;
  /** O executável sem a extensão (`Minecraft`), para o seletor. */
  readonly nome: string;
  /** Caminho do executável: o main tira o ícone dele. */
  readonly caminho: string;
  /** A sessão está com som agora (`AudioSessionStateActive`). */
  readonly ativa: boolean;
};

export type PedidoAoUtilitario =
  | { readonly t: 'sondar' }
  | { readonly t: 'listar' }
  | { readonly t: 'capturar'; readonly pid: number }
  | { readonly t: 'parar' };

export type CodigoDeErroDoUtilitario =
  /** O `.node` não carregou (arquitetura, DLL ausente, caminho). */
  | 'ADDON_AUSENTE'
  /** O Windows recusou ativar a captura por processo (versão, processo inexistente, política). */
  | 'ATIVACAO_RECUSADA'
  | 'PROCESSO_INVALIDO'
  | 'FALHOU';

export type RespostaDoUtilitario =
  | { readonly t: 'sonda'; readonly ok: true; readonly versao: string }
  | { readonly t: 'sonda'; readonly ok: false; readonly erro: CodigoDeErroDoUtilitario }
  | { readonly t: 'sessoes'; readonly sessoes: readonly SessaoDeAudio[] }
  | { readonly t: 'capturando' }
  | { readonly t: 'fim'; readonly motivo: 'PROCESSO_ENCERROU' | 'DISPOSITIVO' | 'FALHOU' }
  | { readonly t: 'erro'; readonly erro: CodigoDeErroDoUtilitario };

const ehRegistro = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const ERROS: readonly string[] = ['ADDON_AUSENTE', 'ATIVACAO_RECUSADA', 'PROCESSO_INVALIDO', 'FALHOU'];
const FINS: readonly string[] = ['PROCESSO_ENCERROU', 'DISPOSITIVO', 'FALHOU'];

/** Um pid do Windows: inteiro positivo de 32 bits (0 é o Idle; o 4, o System). */
export const pidValido = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x > 4 && x <= 0x7fffffff;

/** Visto pelo utility: o que o main pode pedir. */
export function pedidoValido(x: unknown): PedidoAoUtilitario | null {
  if (!ehRegistro(x)) return null;
  switch (x['t']) {
    case 'sondar':
    case 'listar':
    case 'parar':
      return { t: x['t'] };
    case 'capturar':
      return pidValido(x['pid']) ? { t: 'capturar', pid: x['pid'] } : null;
    default:
      return null;
  }
}

function sessaoValida(x: unknown): SessaoDeAudio | null {
  if (!ehRegistro(x)) return null;
  const { pid, nome, caminho, ativa } = x;
  if (!pidValido(pid) || typeof nome !== 'string' || typeof caminho !== 'string' || typeof ativa !== 'boolean') return null;
  if (nome.length === 0 || nome.length > 260 || caminho.length > 1024) return null;
  return { pid, nome, caminho, ativa };
}

/** Visto pelo main: o que o utility respondeu. Lixo vira `null`. */
export function respostaValida(x: unknown): RespostaDoUtilitario | null {
  if (!ehRegistro(x)) return null;
  switch (x['t']) {
    case 'sonda':
      if (x['ok'] === true) return typeof x['versao'] === 'string' ? { t: 'sonda', ok: true, versao: x['versao'].slice(0, 64) } : null;
      return typeof x['erro'] === 'string' && ERROS.includes(x['erro']) ? { t: 'sonda', ok: false, erro: x['erro'] as CodigoDeErroDoUtilitario } : null;
    case 'sessoes': {
      if (!Array.isArray(x['sessoes']) || x['sessoes'].length > 256) return null;
      const sessoes = (x['sessoes'] as unknown[]).map(sessaoValida);
      return sessoes.every((s) => s !== null) ? { t: 'sessoes', sessoes: sessoes as SessaoDeAudio[] } : null;
    }
    case 'capturando':
      return { t: 'capturando' };
    case 'fim':
      return typeof x['motivo'] === 'string' && FINS.includes(x['motivo']) ? { t: 'fim', motivo: x['motivo'] as 'PROCESSO_ENCERROU' | 'DISPOSITIVO' | 'FALHOU' } : null;
    case 'erro':
      return typeof x['erro'] === 'string' && ERROS.includes(x['erro']) ? { t: 'erro', erro: x['erro'] as CodigoDeErroDoUtilitario } : null;
    default:
      return null;
  }
}

/**
 * Sessões de áudio → o que o seletor mostra: uma por executável (o addon já
 * sobe cada sessão até o processo-raiz), quem está com som primeiro. O `id` é
 * `pid:<n>`, a mesma forma do Linux — o renderer não distingue.
 */
export function appsDasSessoes(sessoes: readonly SessaoDeAudio[], excluirPids: ReadonlySet<number>): ReadonlyArray<{ id: string; nome: string; tocando: boolean; caminho: string; pid: number }> {
  const porPid = new Map<number, SessaoDeAudio>();
  for (const s of sessoes) {
    if (excluirPids.has(s.pid)) continue;
    const atual = porPid.get(s.pid);
    if (atual === undefined || (s.ativa && !atual.ativa)) porPid.set(s.pid, s);
  }
  return [...porPid.values()]
    .map((s) => ({ id: `pid:${s.pid}`, nome: s.nome, tocando: s.ativa, caminho: s.caminho, pid: s.pid }))
    .sort((a, b) => Number(b.tocando) - Number(a.tocando) || a.nome.localeCompare(b.nome, 'pt-BR'));
}
