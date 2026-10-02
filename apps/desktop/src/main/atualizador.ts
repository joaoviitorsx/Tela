/**
 * O atualizador do Tela Desktop: liga a política pura (`atualizacao-politica.ts`)
 * a quem faz o trabalho — rede, timers e o `electron-updater` — sem importar
 * nenhum dos três. Tudo entra por `Dependencias`, então o teste roda com
 * motor falso e relógio na mão (`atualizador.test.ts`).
 */
import {
  type ComandoDaPolitica,
  type EstadoDaAtualizacao,
  estadoInicial,
  type EstadoDaPolitica,
  type EventoDaPolitica,
  mesmaVista,
  projetar,
  reduzir,
} from './atualizacao-politica.js';
import { type ModoDeAtualizacao, mensagemDeErro } from './atualizacao-release.js';

/** Quem de fato consulta, baixa e instala. A implementação viva é `motor-electron-updater.ts`. */
export interface MotorDeAtualizacao {
  /** A versão mais nova que a atual, com a página da release; `null` = em dia. */
  verificar(): Promise<{ readonly versao: string; readonly pagina: string } | null>;
  /** Baixa o que `verificar` achou. Resolve com a versão, ou `null` se foi cancelado. */
  baixar(aoProgresso: (percentual: number) => void): Promise<string | null>;
  cancelarDownload(): void;
  /** Instalar quando o app sair. */
  instalarAoSair(ligado: boolean): void;
  /** Fecha o app, instala e abre de novo. */
  instalarAgora(): void;
}

export type Dependencias = {
  readonly modo: ModoDeAtualizacao;
  /** O ajuste "Atualizar automaticamente". */
  readonly automatico: boolean;
  readonly motor: MotorDeAtualizacao;
  readonly agora: () => number;
  /** Agenda `fn` e devolve o cancelamento. */
  readonly agendar: (fn: () => void, ms: number) => () => void;
  /** A vista mudou: o main atualiza a bandeja e avisa a interface. */
  readonly aoMudar: (vista: EstadoDaAtualizacao) => void;
  readonly log: { readonly info: (msg: string) => void; readonly erro: (msg: string, erro?: unknown) => void };
};

/** A primeira verificação espera o app abrir sem disputar CPU e rede com a abertura. */
export const ATRASO_DA_PRIMEIRA_VERIFICACAO_MS = 30_000;
export const INTERVALO_ENTRE_VERIFICACOES_MS = 6 * 60 * 60 * 1000;

export type Atualizador = {
  readonly iniciar: () => void;
  readonly parar: () => void;
  readonly vista: () => EstadoDaAtualizacao;
  readonly aoVivo: (noAr: boolean) => void;
  readonly automatico: (ligado: boolean) => void;
  readonly verificarAgora: () => void;
  readonly reiniciar: () => void;
};

export function criarAtualizador(deps: Dependencias): Atualizador {
  let estado: EstadoDaPolitica = estadoInicial(deps.modo, deps.automatico);
  let vistaAtual = projetar(estado);
  let cancelarTique: (() => void) | null = null;

  function executar(comando: ComandoDaPolitica): void {
    const { motor } = deps;
    switch (comando.tipo) {
      case 'verificar': {
        const { rodada } = comando;
        deps.log.info('verificando atualização');
        motor.verificar().then(
          (achou) =>
            despachar({
              tipo: 'verificacao',
              rodada,
              versao: achou?.versao ?? null,
              pagina: achou?.pagina ?? null,
              em: deps.agora(),
            }),
          (erro: unknown) => falhar(rodada, erro),
        );
        break;
      }
      case 'baixar': {
        const { rodada } = comando;
        deps.log.info('baixando atualização');
        motor
          .baixar((percentual) => despachar({ tipo: 'progresso', rodada, percentual }))
          .then(
            (versao) => {
              // `null`: cancelado por nós (entrou no ar); a política já mudou de fase.
              if (versao !== null) despachar({ tipo: 'baixada', rodada, versao });
            },
            (erro: unknown) => falhar(rodada, erro),
          );
        break;
      }
      case 'cancelar-download':
        deps.log.info('download cancelado: transmissão no ar');
        motor.cancelarDownload();
        break;
      case 'instalar-ao-sair':
        motor.instalarAoSair(comando.ligado);
        break;
      case 'instalar-agora':
        deps.log.info('reiniciando para atualizar');
        try {
          motor.instalarAgora();
        } catch (erro: unknown) {
          deps.log.erro('não deu para reiniciar e atualizar', erro);
        }
        break;
    }
  }

  function falhar(rodada: number, erro: unknown): void {
    // Silencioso para a pessoa (nada de diálogo no meio do jogo): vai ao log
    // e à linha "Última verificação" do AJUSTES.
    deps.log.erro('falha na atualização', erro);
    despachar({ tipo: 'erro', rodada, mensagem: mensagemDeErro(erro), em: deps.agora() });
  }

  function despachar(evento: EventoDaPolitica): void {
    const { estado: seguinte, comandos } = reduzir(estado, evento);
    estado = seguinte;
    const nova = projetar(estado);
    const mudou = !mesmaVista(vistaAtual, nova);
    vistaAtual = nova;
    // A vista sai antes dos comandos: quem ouve já vê "baixando" quando o download começa.
    if (mudou) deps.aoMudar(nova);
    for (const comando of comandos) executar(comando);
  }

  function agendarTique(ms: number): void {
    cancelarTique = deps.agendar(() => {
      despachar({ tipo: 'tique' });
      agendarTique(INTERVALO_ENTRE_VERIFICACOES_MS);
    }, ms);
  }

  return {
    iniciar: () => {
      if (deps.modo === 'desligada' || cancelarTique !== null) return;
      agendarTique(ATRASO_DA_PRIMEIRA_VERIFICACAO_MS);
    },
    parar: () => {
      cancelarTique?.();
      cancelarTique = null;
    },
    vista: () => vistaAtual,
    aoVivo: (noAr) => despachar({ tipo: 'ao-vivo', noAr }),
    automatico: (ligado) => despachar({ tipo: 'automatico', ligado }),
    verificarAgora: () => despachar({ tipo: 'verificar-agora' }),
    reiniciar: () => despachar({ tipo: 'reiniciar' }),
  };
}
