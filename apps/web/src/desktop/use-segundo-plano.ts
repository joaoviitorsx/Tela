import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FonteDeVisibilidade } from '../react/use-aba-visivel.js';
import { useCopia } from '../react/use-copia.js';
import { useEncerrar } from '../react/use-encerrar.js';
import {
  criarEmissorDeEstado,
  estadoParaOMain,
  rotaDosEspectadores,
  rotuloDoEncoder,
  tempoNoAr,
} from './estado-ao-vivo.js';
import type { ModoDaJanelaStore } from './modo-da-janela.js';
import type { ModoDaJanela, PonteDesktop } from './ponte.js';
import type { SessaoAoVivo } from './sessao-ao-vivo.js';

export type PonteDoSegundoPlano = Pick<
  PonteDesktop,
  | 'enviarEstadoAoVivo'
  | 'aoPerguntarFechar'
  | 'responderFechar'
  | 'aoPedirEncerrar'
  | 'aoAlternarOculto'
  | 'aoAtalhoOculto'
  | 'aoPedirParar'
  | 'paradaConcluida'
>;

export const AVISO_DE_SUSPENSAO = 'A transmissão foi encerrada porque o computador entrou em suspensão.';

/** O relógio do painel: um tique por segundo, só enquanto alguém pode ler. */
export function useTempo(inicioMs: number | null, ativo: boolean, agora: () => number = Date.now): string {
  const [agoraMs, setAgoraMs] = useState(agora);
  useEffect(() => {
    if (!ativo) return;
    setAgoraMs(agora());
    const id = window.setInterval(() => setAgoraMs(agora()), 1000);
    return () => window.clearInterval(id);
  }, [ativo, agora]);
  return tempoNoAr(inicioMs, agoraMs);
}

const nunca = (): (() => void) => () => undefined;
const SEMPRE_VISIVEL: FonteDeVisibilidade = { visivel: () => true, assinar: nunca };
const MODO_NORMAL: ModoDaJanelaStore = { atual: () => 'normal', assinar: nunca, pedir: () => undefined };

/**
 * Tudo que a moldura sabe da transmissão e faz por ela (D4): o painel NO AR, o
 * modo compacto, o diálogo de fechar, a bandeja (via o estado que conta ao
 * main) e as ordens que o main manda. Uma fonte só para o painel e para a
 * bandeja: `sessaoAoVivo`.
 *
 * Sem `ponte` (dev no navegador) o painel funciona e o resto simplesmente não
 * existe: não há main para pedir nada.
 */
export function useSegundoPlano(deps: {
  readonly sessao: SessaoAoVivo;
  readonly ponte: PonteDoSegundoPlano | undefined;
  readonly modo?: ModoDaJanelaStore;
  readonly visibilidade?: FonteDeVisibilidade;
  /**
   * Confirma a troca pelo atalho, que é dado com o jogo em tela cheia: a
   * pessoa não vê a janela do Tela, então ouve (ver `AudioCue.privacidade`).
   */
  readonly somDeOculto?: (oculto: boolean) => void;
  /**
   * O que ainda tem de sair antes de o app fechar (a edição "encerrada" do
   * aviso no Discord). Com teto: quem chama decide quanto espera.
   */
  readonly antesDeSair?: () => Promise<void>;
}) {
  const { sessao, ponte } = deps;
  const modoStore = deps.modo ?? MODO_NORMAL;
  const visibilidade = deps.visibilidade ?? SEMPRE_VISIVEL;

  const { state, inicioMs } = useSyncExternalStore(sessao.assinar, sessao.instantaneo, sessao.instantaneo);
  const modo: ModoDaJanela = useSyncExternalStore(modoStore.assinar, modoStore.atual, modoStore.atual);
  const janelaVisivel = useSyncExternalStore(visibilidade.assinar, visibilidade.visivel, visibilidade.visivel);

  const vivo = state.status === 'live' ? state : null;
  const noAr = vivo !== null;
  const compacto = modo === 'compacto';

  const tempo = useTempo(inicioMs, noAr && (janelaVisivel || compacto));

  const parar = useCallback(() => void sessao.parar(), [sessao]);
  const encerrar = useEncerrar(vivo?.peers.length ?? 0, parar);
  const copia = useCopia();

  /* ---- o estado que a bandeja precisa: ≤ 1 Hz, só na mudança ---- */
  const estado = estadoParaOMain(state, inicioMs);
  const emissor = useRef<ReturnType<typeof criarEmissorDeEstado> | null>(null);
  useEffect(() => {
    if (ponte === undefined) return;
    const e = criarEmissorDeEstado({
      enviar: (s) => ponte.enviarEstadoAoVivo(s),
      agora: () => performance.now(),
      agendar: (fn, ms) => {
        const t = window.setTimeout(fn, ms);
        return () => window.clearTimeout(t);
      },
    });
    emissor.current = e;
    return () => {
      e.cancelar();
      emissor.current = null;
    };
  }, [ponte]);
  const { noAr: eNoAr, inicioMs: eInicio, assistindo, capacidade, link, oculto } = estado;
  useEffect(() => {
    emissor.current?.empurrar({ noAr: eNoAr, inicioMs: eInicio, assistindo, capacidade, link, oculto });
  }, [eNoAr, eInicio, assistindo, capacidade, link, oculto, ponte]);

  /* ---- ordens do main ---- */
  const [aviso, setAviso] = useState<string | null>(null);
  const [perguntandoAoFechar, setPerguntandoAoFechar] = useState(false);
  const [lembrar, setLembrar] = useState(false);
  const pedirEncerrar = useRef(encerrar.pedir);
  pedirEncerrar.current = encerrar.pedir;
  const [atalhoOculto, setAtalhoOculto] = useState(false);
  const som = useRef(deps.somDeOculto);
  som.current = deps.somDeOculto;
  /** Uma troca por vez: duas teclas rápidas não podem pausar duas vezes. */
  const trocando = useRef(false);
  const alternarOculto = useCallback(() => {
    if (trocando.current) return;
    trocando.current = true;
    void sessao
      .alternarOculto()
      .then((novo) => {
        if (novo !== null) som.current?.(novo);
      })
      .finally(() => {
        trocando.current = false;
      });
  }, [sessao]);

  useEffect(() => {
    if (ponte === undefined) return;
    const cancelar = [
      ponte.aoPedirEncerrar(() => pedirEncerrar.current()),
      ponte.aoAlternarOculto(alternarOculto),
      ponte.aoAtalhoOculto(setAtalhoOculto),
      ponte.aoPedirParar((motivo) => {
        if (motivo === 'suspensao') setAviso(AVISO_DE_SUSPENSAO);
        // `stop()` libera trilhas, peers e avisa a sala; só então o main segue.
        void sessao
          .parar()
          .then(() => deps.antesDeSair?.())
          .catch(() => undefined)
          .finally(() => ponte.paradaConcluida());
      }),
      ponte.aoPerguntarFechar(() => {
        setLembrar(false);
        setPerguntandoAoFechar(true);
      }),
    ];
    return () => cancelar.forEach((c) => c());
  }, [ponte, sessao, alternarOculto]);

  const responderFechar = useCallback(
    (acao: 'segundo-plano' | 'encerrar' | 'cancelar') => {
      // O `<dialog>` avisa o fechamento também depois de uma resposta: sem a
      // guarda, todo "continuar" seria seguido de um "cancelar" sobrando.
      if (!perguntandoAoFechar) return;
      setPerguntandoAoFechar(false);
      ponte?.responderFechar({ acao, lembrar: acao !== 'cancelar' && lembrar });
    },
    [ponte, lembrar, perguntandoAoFechar],
  );

  return {
    noAr,
    compacto,
    painel: {
      tempo,
      assistindo,
      capacidade,
      rota: vivo === null ? '—' : rotaDosEspectadores(vivo),
      encoder: vivo === null ? '—' : rotuloDoEncoder(vivo),
      link: link === null ? '' : link.replace(/^https?:\/\//, ''),
      oculto,
      /** O atalho só aparece no painel quando o main conseguiu registrá-lo. */
      atalhoOculto: noAr && atalhoOculto ? 'CTRL+SHIFT+O' : null,
      alternarOculto,
    },
    encerrar,
    copiado: copia.copiado,
    copiarLink: () => {
      if (link !== null) copia.copiar(link);
    },
    /** Só há compacto onde há quem redimensione a janela: o main. */
    compactar: deps.modo === undefined ? null : () => modoStore.pedir('compacto'),
    expandir: () => modoStore.pedir('normal'),
    aviso,
    dispensarAviso: () => setAviso(null),
    fechar: { perguntando: perguntandoAoFechar, lembrar, mudarLembrar: setLembrar, responder: responderFechar },
  };
}
