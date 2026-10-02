/**
 * As linhas de comando do PipeWire que o "só o jogo" executa (D3).
 *
 * Só montam argumentos — nunca passam por shell (`execFile`/`spawn` sem
 * `shell`), e todo número vem validado como inteiro. O que cada uma faz,
 * testado na máquina do dono (PipeWire 1.6.9) e descrito em `D3-som.md`:
 *
 * - `pw-loopback` com o lado de captura marcado `Audio/Sink` cria um sink
 *   virtual cujo lado de reprodução vai para a saída real: o jogador segue
 *   ouvindo, e o monitor do sink é o que o Tela captura. O sink pertence ao
 *   PROCESSO — se o app cair, o sink some junto, sem módulo órfão;
 * - `pw-metadata <stream> target.object <sink>` move UM stream (é o que o
 *   pavucontrol faz); apagar a chave devolve ao padrão do gerenciador.
 */
import {
  DESCRICAO_DA_ENTRADA_DO_JOGO,
  DESCRICAO_DA_ENTRADA_DO_SISTEMA,
  DESCRICAO_DO_SINK,
  NOME_DA_CAPTURA_DO_JOGO,
  NOME_DA_CAPTURA_DO_SISTEMA,
  NOME_DA_ENTRADA_DO_JOGO,
  NOME_DA_ENTRADA_DO_SISTEMA,
  NOME_DO_RETORNO,
  NOME_DO_SINK,
} from './grafo-pw.js';

export const FERRAMENTAS = { dump: 'pw-dump', loopback: 'pw-loopback', metadata: 'pw-metadata' } as const;

export type Comando = { readonly cmd: string; readonly args: readonly string[] };

/** Id de nó do PipeWire: inteiro não negativo e sensato. */
function idDeNo(id: number): string {
  if (!Number.isInteger(id) || id < 0 || id > 0x7fffffff) throw new RangeError(`id de nó inválido: ${id}`);
  return String(id);
}

/** Um valor de propriedade que não pode abrir outra propriedade nem escapar do argumento. */
function valorSeguro(v: string): string {
  if (!/^[\w.:@+-]{1,200}$/.test(v)) throw new RangeError(`valor inseguro para o PipeWire: ${v}`);
  return v;
}

export const dump = (): Comando => ({ cmd: FERRAMENTAS.dump, args: [] });

/**
 * O sink do Tela. `alvo` é a saída para onde o jogador segue ouvindo; `null`
 * deixa o gerenciador de sessão ligar o retorno à saída padrão — e SEGUIR a
 * saída padrão se ela mudar (trocou de fone no meio da partida).
 */
export function criarSink(alvo: string | null): Comando {
  const retorno = [`node.name=${NOME_DO_RETORNO}`, ...(alvo === null ? [] : [`target.object=${valorSeguro(alvo)}`])].join(' ');
  return {
    cmd: FERRAMENTAS.loopback,
    args: [
      '-n',
      `${NOME_DO_SINK}_lb`,
      '-i',
      `media.class=Audio/Sink node.name=${NOME_DO_SINK} node.description=${DESCRICAO_DO_SINK} audio.position=[FL,FR]`,
      '-o',
      retorno,
    ],
  };
}

/**
 * A fonte virtual do "só o jogo": copia o monitor do sink do Tela para uma
 * `Audio/Source`, que é o que o Chromium enxerga como dispositivo de entrada
 * (ele esconde monitores de sink). `-C` aponta a captura ao sink; sem
 * `stream.capture.sink=true` ela pegaria uma ENTRADA de nome igual, não o monitor.
 */
export function criarEntradaDoJogo(): Comando {
  return {
    cmd: FERRAMENTAS.loopback,
    args: [
      '-n',
      `${NOME_DA_ENTRADA_DO_JOGO}_lb`,
      '-C',
      NOME_DO_SINK,
      '-i',
      `stream.capture.sink=true node.name=${NOME_DA_CAPTURA_DO_JOGO}`,
      '-o',
      `media.class=Audio/Source node.name=${NOME_DA_ENTRADA_DO_JOGO} node.description=${DESCRICAO_DA_ENTRADA_DO_JOGO}`,
    ],
  };
}

/**
 * O mesmo para o modo "sistema": o monitor da SAÍDA PADRÃO vira uma fonte
 * virtual. Sem `-C`: a captura de um monitor sem alvo explícito acompanha a
 * saída padrão — trocar de fone no meio da partida não deixa o som para trás.
 */
export function criarEntradaDoSistema(): Comando {
  return {
    cmd: FERRAMENTAS.loopback,
    args: [
      '-n',
      `${NOME_DA_ENTRADA_DO_SISTEMA}_lb`,
      '-i',
      `stream.capture.sink=true node.name=${NOME_DA_CAPTURA_DO_SISTEMA}`,
      '-o',
      `media.class=Audio/Source node.name=${NOME_DA_ENTRADA_DO_SISTEMA} node.description=${DESCRICAO_DA_ENTRADA_DO_SISTEMA}`,
    ],
  };
}

/** Manda o stream para o nosso sink. */
export function moverParaSink(stream: number): Comando {
  return { cmd: FERRAMENTAS.metadata, args: ['-n', 'default', idDeNo(stream), 'target.object', NOME_DO_SINK, 'Spa:String'] };
}

/** Devolve o stream: o alvo que ele tinha antes, ou o padrão se não tinha nenhum. */
export function restaurarStream(stream: number, anterior: { readonly valor: string; readonly tipo: string } | null): Comando {
  if (anterior === null) return { cmd: FERRAMENTAS.metadata, args: ['-n', 'default', '-d', idDeNo(stream), 'target.object'] };
  return {
    cmd: FERRAMENTAS.metadata,
    args: ['-n', 'default', idDeNo(stream), 'target.object', valorSeguro(anterior.valor), anterior.tipo === 'Spa:Id' ? 'Spa:Id' : 'Spa:String'],
  };
}

/** `--version` de uma ferramenta, para saber se existe sem tocar em nada. */
export const versao = (ferramenta: string): Comando => ({ cmd: ferramenta, args: ['--version'] });
