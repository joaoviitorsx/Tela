/**
 * O utility process do som no Windows (D3): carrega o addon C++ e conversa
 * com o main pelo protocolo de `protocolo-utilitario.ts`. Serve aos dois
 * modos — "só o jogo" (incluir o jogo) e "sistema" (excluir a call).
 *
 * Roda FORA do processo principal de propósito: um addon que trava ou cai
 * derruba só este processo, e o renderer vê o fim da fonte. Não importa nada
 * do app além do protocolo — é um ponto de entrada, não um módulo.
 *
 *   --addon=<caminho do wasapi_loopback.node>   (o main resolve onde ele está)
 *
 * O PCM sai direto para a porta que o main transferiu em `capturar`; este
 * arquivo só o repassa, sem copiar nem inspecionar. `trocar` reabre a captura
 * com outro alvo na mesma porta (o modo sistema, quando o app de voz muda).
 */
import { createRequire } from 'node:module';
import {
  addonSabeExcluir,
  type CodigoDeErroDoUtilitario,
  type ModoDaCaptura,
  pedidoValido,
  type RespostaDoUtilitario,
  type ProcessoRaiz,
  type SessaoDeAudio,
} from './protocolo-utilitario.js';

/** O que o addon (`native/wasapi-loopback/src/wasapi_loopback.cc`) exporta. */
type Addon = {
  versao(): string;
  listarSessoes(): SessaoDeAudio[];
  /** 1.2.0+: as raízes de todos os processos. */
  listarProcessos?(): ProcessoRaiz[];
  capturar(pid: number, aoBloco: (dados: Float32Array) => void, aoFim: (motivo: string) => void, modo: ModoDaCaptura): { parar(): void };
};

const pai = process.parentPort;
const responder = (r: RespostaDoUtilitario): void => pai.postMessage(r);

function argumento(nome: string): string | null {
  const prefixo = `--${nome}=`;
  const a = process.argv.find((x) => x.startsWith(prefixo));
  return a === undefined ? null : a.slice(prefixo.length);
}

/** O addon lança `Error('CODIGO: detalhe')`; o código vira a resposta, o detalhe vai ao log. */
function codigoDoErro(erro: unknown): CodigoDeErroDoUtilitario {
  const m = erro instanceof Error ? /^(ADDON_AUSENTE|ATIVACAO_RECUSADA|PROCESSO_INVALIDO|FALHOU)/.exec(erro.message) : null;
  if (!(erro instanceof Error)) return 'FALHOU';
  console.error(`[tela-som] ${erro.message}`);
  return (m?.[1] as CodigoDeErroDoUtilitario | undefined) ?? 'FALHOU';
}

let addon: Addon | null = null;
function carregar(): Addon | null {
  if (addon !== null) return addon;
  const caminho = argumento('addon');
  if (caminho === null) return null;
  try {
    // `.node` não se importa por ESM: `require` pelo createRequire.
    addon = createRequire(import.meta.url)(caminho) as Addon;
    return addon;
  } catch (erro: unknown) {
    console.error('[tela-som] o addon não carregou:', erro);
    return null;
  }
}

let captura: { parar(): void } | null = null;
/** A porta do PCM, guardada para `trocar` reabrir a captura nela. */
let porta: { postMessage(mensagem: unknown): void } | null = null;
/** O número do bloco segue entre trocas: o renderer vê um fluxo só. */
let n = 0;

function abrir(a: Addon, pid: number, modo: ModoDaCaptura): { parar(): void } {
  // Uma 1.0 ignoraria o modo e capturaria SÓ o alvo — no sistema, só a call.
  if (modo === 'excluir' && !addonSabeExcluir(a.versao())) throw new Error(`ADDON_AUSENTE: o addon ${a.versao()} não sabe excluir`);
  return a.capturar(
    pid,
    (dados) => porta?.postMessage({ t: 'pcm', n: n++, dados }),
    (motivo) => {
      responder({ t: 'fim', motivo: motivo === 'PROCESSO_ENCERROU' || motivo === 'DISPOSITIVO' ? motivo : 'FALHOU' });
    },
    modo,
  );
}

pai.on('message', (evento) => {
  const pedido = pedidoValido(evento.data);
  if (pedido === null) return;

  if (pedido.t === 'parar') {
    captura?.parar();
    captura = null;
    process.exit(0);
  }

  const a = carregar();
  if (a === null) {
    responder(pedido.t === 'sondar' ? { t: 'sonda', ok: false, erro: 'ADDON_AUSENTE' } : { t: 'erro', erro: 'ADDON_AUSENTE' });
    return;
  }

  try {
    if (pedido.t === 'sondar') {
      responder({ t: 'sonda', ok: true, versao: a.versao() });
    } else if (pedido.t === 'listar') {
      const sessoes = a.listarSessoes();
      let processos: ProcessoRaiz[] | undefined;
      try {
        processos = typeof a.listarProcessos === 'function' ? a.listarProcessos() : undefined;
      } catch {
        processos = undefined;
      }
      responder(processos === undefined ? { t: 'sessoes', sessoes } : { t: 'sessoes', sessoes, processos });
    } else if (pedido.t === 'capturar') {
      const recebida = evento.ports[0];
      if (recebida === undefined || captura !== null) {
        responder({ t: 'erro', erro: 'FALHOU' });
        return;
      }
      porta = recebida;
      captura = abrir(a, pedido.pid, pedido.modo);
      responder({ t: 'capturando' });
    } else {
      // `trocar`: a captura velha para (sem `fim`: quem pediu sabe) e a nova
      // abre na mesma porta. Se a nova falhar, fica sem captura e o main encerra.
      if (captura === null || porta === null) {
        responder({ t: 'erro', erro: 'FALHOU' });
        return;
      }
      captura.parar();
      captura = null;
      captura = abrir(a, pedido.pid, pedido.modo);
      responder({ t: 'capturando' });
    }
  } catch (erro: unknown) {
    const codigo = codigoDoErro(erro);
    responder(pedido.t === 'sondar' ? { t: 'sonda', ok: false, erro: codigo } : { t: 'erro', erro: codigo });
  }
});
