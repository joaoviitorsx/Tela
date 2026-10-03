/**
 * Os ajustes do app (D4), puros: o que é válido, o que é o padrão, como vira
 * arquivo. O main só lê e grava; quem decide o formato é aqui, para que um
 * `ajustes.json` editado à mão ou vindo de outra versão nunca derrube a
 * abertura — o que não reconhece volta ao padrão, campo a campo.
 */

import { CANTOS_DO_PAINEL, type CantoDoPainel } from './painel-sobre-o-jogo.js';

/** O que fechar a janela faz AO VIVO. `perguntar` só até a pessoa marcar "lembrar". */
export type AoFecharAoVivo = 'perguntar' | 'segundo-plano' | 'encerrar';

export type Ajustes = {
  /** Abre com o sistema, escondido na bandeja. NUNCA captura sozinho. */
  readonly iniciarComSistema: boolean;
  /** Fechar a janela com a transmissão fora do ar vai para a bandeja, em vez de sair. */
  readonly fecharEmSegundoPlano: boolean;
  /** O modo compacto fica sempre por cima do jogo. */
  readonly sempreNoTopoNoCompacto: boolean;
  /** A resposta lembrada de "Continuar transmitindo em segundo plano?". */
  readonly aoFecharAoVivo: AoFecharAoVivo;
  /** Verifica e baixa atualizações sozinho (nunca ao vivo, D5). Desligado, só "verificar agora". */
  readonly atualizarAutomaticamente: boolean;
  /** A faixa "AO VIVO · 3 assistindo" por cima do jogo, ao vivo. */
  readonly painelSobreOJogo: boolean;
  readonly cantoDoPainel: CantoDoPainel;
};

export const AJUSTES_PADRAO: Ajustes = {
  iniciarComSistema: false,
  fecharEmSegundoPlano: false,
  sempreNoTopoNoCompacto: false,
  aoFecharAoVivo: 'perguntar',
  atualizarAutomaticamente: true,
  painelSobreOJogo: false,
  cantoDoPainel: 'sup-dir',
};

const ESCOLHAS: ReadonlySet<string> = new Set<AoFecharAoVivo>(['perguntar', 'segundo-plano', 'encerrar']);

const CAMPOS_BOOLEANOS = [
  'iniciarComSistema',
  'fecharEmSegundoPlano',
  'sempreNoTopoNoCompacto',
  'atualizarAutomaticamente',
  'painelSobreOJogo',
] as const;

const CANTOS: ReadonlySet<string> = new Set(CANTOS_DO_PAINEL);

/**
 * Aplica um objeto desconhecido por cima de `base`, campo a campo: só entra o
 * que tem o tipo certo. Serve ao arquivo (`base` = padrão) e ao IPC (`base` =
 * ajustes atuais, e o renderer manda só o que mudou).
 */
export function mesclarAjustes(base: Ajustes, bruto: unknown): Ajustes {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return base;
  const dados = bruto as Record<string, unknown>;
  const proximo: { -readonly [K in keyof Ajustes]: Ajustes[K] } = { ...base };
  for (const campo of CAMPOS_BOOLEANOS) {
    const valor = dados[campo];
    if (typeof valor === 'boolean') proximo[campo] = valor;
  }
  const escolha = dados['aoFecharAoVivo'];
  if (typeof escolha === 'string' && ESCOLHAS.has(escolha)) proximo.aoFecharAoVivo = escolha as AoFecharAoVivo;
  const canto = dados['cantoDoPainel'];
  if (typeof canto === 'string' && CANTOS.has(canto)) proximo.cantoDoPainel = canto as CantoDoPainel;
  return proximo;
}

/** O conteúdo do arquivo → ajustes. JSON quebrado, vazio ou de outro tipo = padrão. */
export function lerAjustes(texto: string | null): Ajustes {
  if (texto === null) return AJUSTES_PADRAO;
  try {
    return mesclarAjustes(AJUSTES_PADRAO, JSON.parse(texto) as unknown);
  } catch {
    return AJUSTES_PADRAO;
  }
}

export function serializarAjustes(ajustes: Ajustes): string {
  return `${JSON.stringify(ajustes, null, 2)}\n`;
}

export function mesmosAjustes(a: Ajustes, b: Ajustes): boolean {
  return (
    a.iniciarComSistema === b.iniciarComSistema &&
    a.fecharEmSegundoPlano === b.fecharEmSegundoPlano &&
    a.sempreNoTopoNoCompacto === b.sempreNoTopoNoCompacto &&
    a.aoFecharAoVivo === b.aoFecharAoVivo &&
    a.atualizarAutomaticamente === b.atualizarAutomaticamente &&
    a.painelSobreOJogo === b.painelSobreOJogo &&
    a.cantoDoPainel === b.cantoDoPainel
  );
}
