/**
 * As linhas de comando do PipeWire que o "só o jogo" e o "sistema" executam (D3).
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
import { NOME_DO_SINK, NOS_DO_JOGO, NOS_DO_SISTEMA, type NosDoModo } from './grafo-pw.js';

export const FERRAMENTAS = { dump: 'pw-dump', loopback: 'pw-loopback', metadata: 'pw-metadata' } as const;

export type Comando = { readonly cmd: string; readonly args: readonly string[] };

/** Id de nó do PipeWire: inteiro não negativo e sensato. */
function idDeNo(id: number): string {
  if (!Number.isInteger(id) || id < 0 || id > 0x7fffffff) throw new RangeError(`id de nó inválido: ${id}`);
  return String(id);
}

/**
 * Um valor vindo de FORA (nome de saída, alvo que outro cliente gravou no
 * metadado) que vai virar elemento de argv. Sem shell, então espaço e acento
 * são nomes de dispositivo legítimos ("Fone USB") e passam; o que não passa:
 *
 * - começar com `-`: o `pw-metadata` usa `getopt_long`, que PERMUTA argumentos,
 *   e `-d`/`--help`/`-n` no lugar do valor viram opção (S-14);
 * - caractere de controle (`\n`, NUL…) e tamanho fora de 1..200.
 */
export function valorSeguro(v: string): string {
  let controle = false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) controle = true;
  }
  if (v.length < 1 || v.length > 200 || v.startsWith('-') || controle) throw new RangeError('valor inseguro para o PipeWire');
  return v;
}

/**
 * O valor dentro de uma lista `chave=valor chave=valor` (propriedades do
 * `pw-loopback`, SPA-JSON): o simples vai cru; o resto, entre aspas com `"` e
 * `\` escapados — com espaço ou `=` ele abriria OUTRA propriedade.
 */
function valorDePropriedade(v: string): string {
  const seguro = valorSeguro(v);
  return /^[\w.:@+-]+$/.test(seguro) ? seguro : JSON.stringify(seguro);
}

export const dump = (): Comando => ({ cmd: FERRAMENTAS.dump, args: [] });

/**
 * O sink do Tela. `alvo` é a saída para onde o jogador segue ouvindo; `null`
 * deixa o gerenciador de sessão ligar o retorno à saída padrão — e SEGUIR a
 * saída padrão se ela mudar (trocou de fone no meio da partida). `nos` diz de
 * qual modo (o "só o jogo" ou o "sistema").
 */
export function criarSink(alvo: string | null, nos: NosDoModo = NOS_DO_JOGO): Comando {
  const retorno = [`node.name=${nos.retorno}`, ...(alvo === null ? [] : [`target.object=${valorDePropriedade(alvo)}`])].join(' ');
  return {
    cmd: FERRAMENTAS.loopback,
    args: [
      '-n',
      `${nos.sink}_lb`,
      '-i',
      `media.class=Audio/Sink node.name=${nos.sink} node.description=${nos.descricaoDoSink} audio.position=[FL,FR]`,
      '-o',
      retorno,
    ],
  };
}

/**
 * A fonte virtual de um modo: copia o monitor do sink do Tela para uma
 * `Audio/Source`, que é o que o Chromium enxerga como dispositivo de entrada
 * (ele esconde monitores de sink). `-C` aponta a captura ao sink; sem
 * `stream.capture.sink=true` ela pegaria uma ENTRADA de nome igual, não o monitor.
 */
export function criarEntrada(nos: NosDoModo): Comando {
  return {
    cmd: FERRAMENTAS.loopback,
    args: [
      '-n',
      `${nos.entrada}_lb`,
      '-C',
      nos.sink,
      '-i',
      `stream.capture.sink=true node.name=${nos.captura}`,
      '-o',
      `media.class=Audio/Source node.name=${nos.entrada} node.description=${nos.descricaoDaEntrada}`,
    ],
  };
}

/** A fonte do "só o jogo": o monitor do sink Tela-Jogo. */
export const criarEntradaDoJogo = (): Comando => criarEntrada(NOS_DO_JOGO);

/**
 * A fonte do "sistema": o monitor do sink Tela-Sistema — tudo que toca na
 * saída padrão MENOS a call, que nunca é movida para ele. (Antes era o
 * monitor da saída padrão inteira, com a call junto.)
 */
export const criarEntradaDoSistema = (): Comando => criarEntrada(NOS_DO_SISTEMA);

/** Manda o stream para um sink nosso (o do jogo, se não disser qual). */
export function moverParaSink(stream: number, sink: string = NOME_DO_SINK): Comando {
  return { cmd: FERRAMENTAS.metadata, args: ['-n', 'default', idDeNo(stream), 'target.object', valorSeguro(sink), 'Spa:String'] };
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
