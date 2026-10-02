/**
 * A política de atualização do Tela Desktop (PLANO-desktop §5), uma máquina de
 * estados PURA: eventos entram, o novo estado e os comandos saem. Quem faz rede,
 * timer e `electron-updater` é `atualizador.ts`; aqui só se decide.
 *
 * A regra que organiza tudo: **nunca se mexe numa transmissão no ar**. Então,
 * AO VIVO:
 *  - não se verifica (nem a cada 6 h, nem a pedido);
 *  - não se baixa — um download em curso é CANCELADO e retomado quando a
 *    transmissão acaba (o download disputaria o upload com quem assiste);
 *  - não se reinicia. Se o download terminou antes de ir ao ar, a atualização
 *    espera: instala quando a pessoa sair do app (decisão dela, e o `sair` ao
 *    vivo já para a sessão com `stop()`), ou no REINICIAR E ATUALIZAR depois.
 *
 * Cada verificação/download tem uma `rodada`; evento de rodada velha (um
 * download cancelado que ainda responde) é ignorado, senão cancelar e retomar
 * em seguida confundiria os dois.
 */
import type { ModoDeAtualizacao } from './atualizacao-release.js';

export type FaseInterna = 'ocioso' | 'verificando' | 'baixando' | 'pronta';

export type EstadoDaPolitica = {
  readonly modo: ModoDeAtualizacao;
  /** O ajuste "Atualizar automaticamente". */
  readonly automatico: boolean;
  readonly aoVivo: boolean;
  readonly fase: FaseInterna;
  readonly rodada: number;
  /** Versão achada e ainda não instalada. */
  readonly versaoNova: string | null;
  /** Página da release (deb/rpm: é onde se baixa o pacote). */
  readonly pagina: string | null;
  /** 0–100, só vale baixando. */
  readonly progresso: number;
  readonly ultimaVerificacaoMs: number | null;
  readonly erro: string | null;
  /** A pessoa pediu "verificar agora": vale baixar mesmo com o ajuste desligado. */
  readonly manual: boolean;
};

export type EventoDaPolitica =
  /** O relógio (30 s depois de abrir, e a cada 6 h). */
  | { readonly tipo: 'tique' }
  | { readonly tipo: 'verificar-agora' }
  | { readonly tipo: 'ao-vivo'; readonly noAr: boolean }
  | { readonly tipo: 'automatico'; readonly ligado: boolean }
  | { readonly tipo: 'reiniciar' }
  | {
      readonly tipo: 'verificacao';
      readonly rodada: number;
      readonly versao: string | null;
      readonly pagina: string | null;
      readonly em: number;
    }
  | { readonly tipo: 'progresso'; readonly rodada: number; readonly percentual: number }
  | { readonly tipo: 'baixada'; readonly rodada: number; readonly versao: string }
  | { readonly tipo: 'erro'; readonly rodada: number; readonly mensagem: string; readonly em: number };

export type ComandoDaPolitica =
  | { readonly tipo: 'verificar'; readonly rodada: number }
  | { readonly tipo: 'baixar'; readonly rodada: number }
  | { readonly tipo: 'cancelar-download' }
  | { readonly tipo: 'instalar-ao-sair'; readonly ligado: boolean }
  | { readonly tipo: 'instalar-agora' };

export type Transicao = { readonly estado: EstadoDaPolitica; readonly comandos: readonly ComandoDaPolitica[] };

export function estadoInicial(modo: ModoDeAtualizacao, automatico: boolean): EstadoDaPolitica {
  return {
    modo,
    automatico,
    aoVivo: false,
    fase: 'ocioso',
    rodada: 0,
    versaoNova: null,
    pagina: null,
    progresso: 0,
    ultimaVerificacaoMs: null,
    erro: null,
    manual: false,
  };
}

const sem = (estado: EstadoDaPolitica): Transicao => ({ estado, comandos: [] });

/** Pode começar algo agora: há o que atualizar neste modo, fora do ar, e nada em curso. */
function livre(e: EstadoDaPolitica): boolean {
  return e.modo !== 'desligada' && !e.aoVivo && e.fase === 'ocioso';
}

function comecarVerificacao(e: EstadoDaPolitica, manual: boolean): Transicao {
  const rodada = e.rodada + 1;
  return {
    estado: { ...e, fase: 'verificando', rodada, manual: manual || e.manual, erro: null },
    comandos: [{ tipo: 'verificar', rodada }],
  };
}

function comecarDownload(e: EstadoDaPolitica): Transicao {
  const rodada = e.rodada + 1;
  return {
    estado: { ...e, fase: 'baixando', rodada, progresso: 0 },
    comandos: [{ tipo: 'baixar', rodada }],
  };
}

/** Há versão nova, é para baixar (ajuste ligado ou pedido manual) e dá para baixar agora? */
function deveBaixar(e: EstadoDaPolitica): boolean {
  return e.modo === 'automatica' && e.versaoNova !== null && (e.automatico || e.manual) && livre(e);
}

export function reduzir(e: EstadoDaPolitica, evento: EventoDaPolitica): Transicao {
  switch (evento.tipo) {
    case 'tique':
      return e.automatico && livre(e) ? comecarVerificacao(e, false) : sem(e);

    case 'verificar-agora':
      return livre(e) ? comecarVerificacao(e, true) : sem(e);

    case 'ao-vivo': {
      if (evento.noAr === e.aoVivo) return sem(e);
      const seguinte = { ...e, aoVivo: evento.noAr };
      if (evento.noAr) {
        // Entrou no ar no meio do download: para. A rodada muda para o que
        // ainda chegar do download cancelado ser ignorado.
        if (e.fase === 'baixando') {
          return {
            estado: { ...seguinte, fase: 'ocioso', rodada: e.rodada + 1, progresso: 0 },
            comandos: [{ tipo: 'cancelar-download' }],
          };
        }
        return sem(seguinte);
      }
      // Saiu do ar: o que ficou esperando (versão achada ao vivo) agora baixa.
      return deveBaixar(seguinte) ? comecarDownload(seguinte) : sem(seguinte);
    }

    case 'automatico': {
      if (evento.ligado === e.automatico) return sem(e);
      const seguinte = { ...e, automatico: evento.ligado };
      if (!evento.ligado) {
        if (e.fase === 'baixando' && !e.manual) {
          return {
            estado: { ...seguinte, fase: 'ocioso', rodada: e.rodada + 1, progresso: 0 },
            comandos: [{ tipo: 'cancelar-download' }],
          };
        }
        // Desligar vale também para o que já está baixado: não instala sozinho ao sair.
        return e.fase === 'pronta'
          ? { estado: seguinte, comandos: [{ tipo: 'instalar-ao-sair', ligado: false }] }
          : sem(seguinte);
      }
      if (e.fase === 'pronta') return { estado: seguinte, comandos: [{ tipo: 'instalar-ao-sair', ligado: true }] };
      if (deveBaixar(seguinte)) return comecarDownload(seguinte);
      return livre(seguinte) ? comecarVerificacao(seguinte, false) : sem(seguinte);
    }

    case 'reiniciar':
      // Ao vivo, ou sem nada baixado, não há o que reiniciar: a interface nem oferece, o main também recusa.
      return e.fase === 'pronta' && !e.aoVivo && e.modo === 'automatica'
        ? { estado: e, comandos: [{ tipo: 'instalar-agora' }] }
        : sem(e);

    case 'verificacao': {
      if (e.fase !== 'verificando' || evento.rodada !== e.rodada) return sem(e);
      const base = {
        ...e,
        fase: 'ocioso' as const,
        ultimaVerificacaoMs: evento.em,
        erro: null,
        versaoNova: evento.versao,
        pagina: evento.versao === null ? null : evento.pagina,
      };
      if (evento.versao === null) return sem({ ...base, manual: false });
      // deb/rpm: só avisa. Nunca baixa pacote.
      if (e.modo !== 'automatica') return sem({ ...base, manual: false });
      return deveBaixar(base) ? comecarDownload(base) : sem(base);
    }

    case 'progresso': {
      if (e.fase !== 'baixando' || evento.rodada !== e.rodada) return sem(e);
      const percentual = Math.max(0, Math.min(100, Math.round(evento.percentual)));
      return percentual === e.progresso ? sem(e) : sem({ ...e, progresso: percentual });
    }

    case 'baixada': {
      if (e.fase !== 'baixando' || evento.rodada !== e.rodada) return sem(e);
      return {
        estado: { ...e, fase: 'pronta', progresso: 100, versaoNova: evento.versao, manual: false, erro: null },
        // Quem pediu a atualização (ajuste ou "verificar agora") a quer ao sair.
        comandos: [{ tipo: 'instalar-ao-sair', ligado: true }],
      };
    }

    case 'erro': {
      if ((e.fase !== 'verificando' && e.fase !== 'baixando') || evento.rodada !== e.rodada) return sem(e);
      return sem({
        ...e,
        fase: 'ocioso',
        progresso: 0,
        manual: false,
        erro: evento.mensagem,
        ultimaVerificacaoMs: evento.em,
      });
    }
  }
}

/* ------------------------------------------------------------------ vista */

export type FaseVisivel = 'desligada' | 'em-dia' | 'verificando' | 'disponivel' | 'baixando' | 'pronta' | 'erro';

/** O que a interface (AJUSTES) e a bandeja enxergam. É o contrato `EstadoDaAtualizacao` de `ponte.ts`. */
export type EstadoDaAtualizacao = {
  readonly modo: ModoDeAtualizacao;
  readonly fase: FaseVisivel;
  readonly versaoNova: string | null;
  /** 0–100 baixando; `null` fora disso. */
  readonly progresso: number | null;
  readonly ultimaVerificacaoMs: number | null;
  readonly erro: string | null;
  /** Há versão nova, mas o app está ao vivo: ela espera a transmissão acabar. */
  readonly adiada: boolean;
  readonly podeVerificar: boolean;
  readonly podeReiniciar: boolean;
  /** Onde baixar o pacote (só deb/rpm). `https:`, montado pelo main. */
  readonly pagina: string | null;
};

export function projetar(e: EstadoDaPolitica): EstadoDaAtualizacao {
  let fase: FaseVisivel;
  if (e.modo === 'desligada') fase = 'desligada';
  else if (e.fase === 'verificando') fase = 'verificando';
  else if (e.fase === 'baixando') fase = 'baixando';
  else if (e.fase === 'pronta') fase = 'pronta';
  else if (e.erro !== null) fase = 'erro';
  else if (e.versaoNova !== null) fase = 'disponivel';
  else fase = 'em-dia';
  return {
    modo: e.modo,
    fase,
    versaoNova: e.versaoNova,
    progresso: e.fase === 'baixando' ? e.progresso : null,
    ultimaVerificacaoMs: e.ultimaVerificacaoMs,
    erro: e.erro,
    adiada: e.fase === 'ocioso' && e.versaoNova !== null && e.aoVivo && e.modo === 'automatica',
    podeVerificar: livre(e),
    podeReiniciar: e.fase === 'pronta' && !e.aoVivo && e.modo === 'automatica',
    pagina: e.modo === 'avisar' ? e.pagina : null,
  };
}

export function mesmaVista(a: EstadoDaAtualizacao, b: EstadoDaAtualizacao): boolean {
  return (
    a.modo === b.modo &&
    a.fase === b.fase &&
    a.versaoNova === b.versaoNova &&
    a.progresso === b.progresso &&
    a.ultimaVerificacaoMs === b.ultimaVerificacaoMs &&
    a.erro === b.erro &&
    a.adiada === b.adiada &&
    a.podeVerificar === b.podeVerificar &&
    a.podeReiniciar === b.podeReiniciar &&
    a.pagina === b.pagina
  );
}
