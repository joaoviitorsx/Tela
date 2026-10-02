/**
 * O utility process do som do jogo no Windows (D3): carrega o addon C++ e
 * conversa com o main pelo protocolo de `protocolo-utilitario.ts`.
 *
 * Roda FORA do processo principal de propósito: um addon que trava ou cai
 * derruba só este processo, e o renderer vê o fim da fonte. Não importa nada
 * do app além do protocolo — é um ponto de entrada, não um módulo.
 *
 *   --addon=<caminho do wasapi_loopback.node>   (o main resolve onde ele está)
 *
 * O PCM sai direto para a porta que o main transferiu em `capturar`; este
 * arquivo só o repassa, sem copiar nem inspecionar.
 */
import { createRequire } from 'node:module';
import {
  type CodigoDeErroDoUtilitario,
  pedidoValido,
  type RespostaDoUtilitario,
  type SessaoDeAudio,
} from './protocolo-utilitario.js';

/** O que o addon (`native/wasapi-loopback/src/wasapi_loopback.cc`) exporta. */
type Addon = {
  versao(): string;
  listarSessoes(): SessaoDeAudio[];
  capturar(pid: number, aoBloco: (dados: Float32Array) => void, aoFim: (motivo: string) => void): { parar(): void };
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
      responder({ t: 'sessoes', sessoes: a.listarSessoes() });
    } else {
      const porta = evento.ports[0];
      if (porta === undefined || captura !== null) {
        responder({ t: 'erro', erro: 'FALHOU' });
        return;
      }
      let n = 0;
      captura = a.capturar(
        pedido.pid,
        (dados) => porta.postMessage({ t: 'pcm', n: n++, dados }),
        (motivo) => {
          responder({ t: 'fim', motivo: motivo === 'PROCESSO_ENCERROU' || motivo === 'DISPOSITIVO' ? motivo : 'FALHOU' });
        },
      );
      responder({ t: 'capturando' });
    }
  } catch (erro: unknown) {
    const codigo = codigoDoErro(erro);
    responder(pedido.t === 'sondar' ? { t: 'sonda', ok: false, erro: codigo } : { t: 'erro', erro: codigo });
  }
});
