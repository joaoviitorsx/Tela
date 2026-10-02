import type { AudioCapture, AudioDevice } from '../core/ports/audio-capture.js';
import type { ErroSomJogo, FimDoSomDoJogo, PonteDesktop } from './ponte.js';
import type { PortaReal } from './porta-nativa.js';
import type { PortasDeSom } from './porta-som.js';
import type { SomDesktop } from './som-desktop.js';
import type { TrilhaDePcm } from './trilha-pcm.js';

/**
 * O `AudioCapture` do app desktop (D3): o mesmo contrato que a
 * `BroadcastSession` usa, com as três escolhas atrás dele.
 *
 * A captura de TELA nunca traz áudio no app (`som-na-captura.ts`): todo som
 * passa por aqui.
 *
 * - **Linux, Sistema:** o main cria o sink "Tela-Sistema", move para ele
 *   tudo que toca MENOS a call e expõe o monitor como fonte virtual
 *   ("Tela-Sistema-Entrada"); aqui se a captura como um microfone;
 * - **Linux, Só o jogo:** o mesmo, com o sink "Tela-Jogo" e só o app
 *   escolhido ("Tela-Jogo-Entrada"). (O Chromium não lista monitores de sink
 *   — por isso as fontes.)
 * - **Windows, Sistema e Só o jogo:** o main sobe o utility process com o
 *   addon WASAPI (excluindo o app de voz, ou incluindo só o jogo); o PCM
 *   chega por uma `MessagePort` e vira trilha por um `AudioWorklet`;
 * - **Sem som:** a home nem pede (`audioDeviceId` nulo); se pedir, recusa.
 *
 * Toda falha vira uma exceção — a sessão transmite MUDA, em vez de não
 * transmitir (`broadcast-session.ts`) — e vira também um `resultado` na loja,
 * que é o que a interface mostra como modo real ("SEM SOM · o Windows
 * recusou"). Nunca troca por outro modo em silêncio.
 */
export type DepsDoAudioDesktop = {
  readonly ponte: Pick<PonteDesktop, 'som'>;
  readonly som: Pick<SomDesktop, 'escolhaAtual' | 'registrar'>;
  /** O `getUserMedia` de sempre (`adapters/browser-audio-capture.ts`). */
  readonly navegador: AudioCapture;
  readonly portas: PortasDeSom;
  readonly criarTrilhaDePcm: (porta: PortaReal) => Promise<TrilhaDePcm>;
  readonly esperar: (ms: number) => Promise<void>;
};

/** O Chromium enxerga um sink novo do PipeWire em instantes, não na mesma hora. */
const TENTATIVAS_DE_ACHAR_O_MONITOR = 12;
const PASSO_DAS_TENTATIVAS_MS = 250;

const MOTIVO_DO_ERRO: Record<ErroSomJogo, string> = {
  INDISPONIVEL: 'o componente de som não está disponível',
  APP_NAO_ENCONTRADO: 'esse programa não está mais tocando',
  FALHOU: 'o som não iniciou',
  OCUPADO: 'o som já está em uso',
};

const MOTIVO_DO_FIM: Record<FimDoSomDoJogo['motivo'], string> = {
  SINK_CAIU: 'o som parou',
  PROCESSO_ENCERROU: 'o jogo fechou',
  COMPONENTE_CAIU: 'o componente de som caiu',
};

/** Casa o rótulo do dispositivo com a descrição que o main deu, sem depender de maiúsculas. */
export function acharMonitor(dispositivos: readonly AudioDevice[], descricao: string): AudioDevice | null {
  const alvo = descricao.toLowerCase();
  return dispositivos.find((d) => d.label.toLowerCase().includes(alvo)) ?? null;
}

export function makeAudioDesktop(deps: DepsDoAudioDesktop): AudioCapture {
  const { navegador, ponte } = deps;

  /** Devolve a trilha com `stop()` encadeado a `aoParar`, uma vez só. */
  const aoParar = (trilha: MediaStreamTrack, fn: () => void): void => {
    const original = trilha.stop.bind(trilha);
    let feito = false;
    trilha.stop = () => {
      original();
      if (feito) return;
      feito = true;
      fn();
    };
  };

  const falhar = (motivo: string): never => {
    deps.som.registrar({ situacao: 'falhou', motivo });
    throw new Error(motivo);
  };

  /** O fim por fora (o jogo fechou…): a trilha acaba e a interface diz por quê. */
  const ligarOFim = (encerrar: () => void): (() => void) =>
    ponte.som.aoEncerrar((fim) => {
      deps.som.registrar({ situacao: 'parou', motivo: MOTIVO_DO_FIM[fim.motivo] });
      encerrar();
    });

  const monitorComEspera = async (descricao: string): Promise<AudioDevice | null> => {
    for (let i = 0; i < TENTATIVAS_DE_ACHAR_O_MONITOR; i++) {
      const achado = acharMonitor(await navegador.listMonitors(), descricao);
      if (achado !== null) return achado;
      await deps.esperar(PASSO_DAS_TENTATIVAS_MS);
    }
    return null;
  };

  /**
   * Linux: o main já criou a fonte virtual (do jogo ou do sistema); aqui se a
   * acha pelo rótulo — o Chromium só a enxerga instantes depois — e captura.
   * Qualquer falha desfaz o que o main montou.
   */
  const capturarEntrada = async (descricao: string, oQue: string): Promise<MediaStreamTrack> => {
    await navegador.requestPermission();
    const monitor = await monitorComEspera(descricao);
    if (monitor === null) {
      ponte.som.pararSom();
      return falhar(`o navegador não enxergou ${oQue}`);
    }
    let trilha: MediaStreamTrack;
    try {
      trilha = await navegador.capture(monitor.id);
    } catch {
      ponte.som.pararSom();
      return falhar(`não consegui capturar ${oQue}`);
    }
    const parar = ligarOFim(() => {
      trilha.stop();
      trilha.dispatchEvent(new Event('ended'));
    });
    aoParar(trilha, () => {
      parar();
      ponte.som.pararSom();
    });
    deps.som.registrar({ situacao: 'ativo' });
    return trilha;
  };

  /** Windows: o PCM do addon chega pela porta `id` e vira trilha. */
  const pcmPorPorta = async (id: number, oQue: string): Promise<MediaStreamTrack> => {
    let pcm: TrilhaDePcm;
    try {
      pcm = await deps.criarTrilhaDePcm(await deps.portas.aguardar(id));
    } catch {
      ponte.som.pararSom();
      return falhar(`não consegui montar ${oQue}`);
    }
    const parar = ligarOFim(pcm.encerrar);
    aoParar(pcm.trilha, () => {
      parar();
      ponte.som.pararSom();
    });
    deps.som.registrar({ situacao: 'ativo' });
    return pcm.trilha;
  };

  return {
    requestPermission: () => navegador.requestPermission(),
    listMonitors: () => navegador.listMonitors(),

    async capture() {
      const escolha = deps.som.escolhaAtual();

      if (escolha.tipo === 'nenhum') throw new Error('sem som por escolha');

      // Tudo menos a call: tela ou janela, nas duas plataformas.
      if (escolha.tipo === 'sistema') {
        const r = await ponte.som.iniciarSistema();
        if (!r.ok) return falhar(MOTIVO_DO_ERRO[r.erro]);
        if (r.via === 'entrada') return capturarEntrada(r.descricao, 'o som do sistema');
        const trilha = await pcmPorPorta(r.id, 'o som do sistema');
        if (r.semCall !== undefined) deps.som.registrar({ situacao: 'ativo', semCall: r.semCall });
        return trilha;
      }

      if (escolha.appId === null) return falhar('nenhum jogo escolhido');
      const r = await ponte.som.iniciarJogo(escolha.appId);
      if (!r.ok) return falhar(MOTIVO_DO_ERRO[r.erro]);
      return r.via === 'entrada' ? capturarEntrada(r.descricao, 'o som do jogo') : pcmPorPorta(r.id, 'o som do jogo');
    },
  };
}
