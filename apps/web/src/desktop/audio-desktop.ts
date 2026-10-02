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
 * A sessão só chama `capture()` quando a captura de TELA não trouxe áudio —
 * então o "Sistema" do Windows (o `loopback` do Electron, que vem junto da
 * tela) nem passa por aqui. O que passa:
 *
 * - **Linux, Sistema:** o main cria uma fonte virtual com o monitor da saída
 *   padrão ("Tela-Sistema-Entrada"); aqui se a captura como um microfone;
 * - **Linux, Só o jogo:** o main cria o sink "Tela-Jogo", move o app para ele
 *   e expõe o monitor como fonte virtual ("Tela-Jogo-Entrada"); aqui se a
 *   captura. (O Chromium não lista monitores de sink — por isso a fonte.)
 * - **Windows, Só o jogo:** o main sobe o utility process com o addon WASAPI;
 *   o PCM chega por uma `MessagePort` e vira trilha por um `AudioWorklet`;
 * - **Sem som:** a home nem pede (`audioDeviceId` nulo); se pedir, recusa.
 *
 * Toda falha vira uma exceção — a sessão transmite MUDA, em vez de não
 * transmitir (`broadcast-session.ts`) — e vira também um `resultado` na loja,
 * que é o que a interface mostra como modo real ("SEM SOM · o Windows
 * recusou"). Nunca troca por outro modo em silêncio.
 */
export type DepsDoAudioDesktop = {
  readonly ponte: Pick<PonteDesktop, 'som'>;
  readonly plataforma: PonteDesktop['plataforma'];
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
  INDISPONIVEL: 'o componente do som do jogo não está disponível',
  APP_NAO_ENCONTRADO: 'esse programa não está mais tocando',
  FALHOU: 'o som do jogo não iniciou',
  OCUPADO: 'o som do jogo já está em uso',
};

const MOTIVO_DO_FIM: Record<FimDoSomDoJogo['motivo'], string> = {
  SINK_CAIU: 'o som do jogo parou',
  PROCESSO_ENCERROU: 'o jogo fechou',
  COMPONENTE_CAIU: 'o componente do som do jogo caiu',
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

  const jogoNoWindows = async (id: number): Promise<MediaStreamTrack> => {
    let pcm: TrilhaDePcm;
    try {
      pcm = await deps.criarTrilhaDePcm(await deps.portas.aguardar(id));
    } catch {
      ponte.som.pararSom();
      return falhar('não consegui montar o som do jogo');
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

      if (escolha.tipo === 'sistema') {
        if (deps.plataforma === 'linux') {
          const r = await ponte.som.iniciarSistema();
          if (!r.ok) return falhar(MOTIVO_DO_ERRO[r.erro]);
          return capturarEntrada(r.descricao, 'o som do sistema');
        }
        // Windows: o som do sistema vem junto da TELA. Chegar aqui é uma janela.
        return falhar('transmitir uma janela não leva o som do sistema');
      }

      if (escolha.appId === null) return falhar('nenhum jogo escolhido');
      const r = await ponte.som.iniciarJogo(escolha.appId);
      if (!r.ok) return falhar(MOTIVO_DO_ERRO[r.erro]);
      return r.via === 'entrada' ? capturarEntrada(r.descricao, 'o som do jogo') : jogoNoWindows(r.id);
    },
  };
}
