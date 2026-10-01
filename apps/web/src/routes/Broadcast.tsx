import { PRESETS, PRESET_ORDER, type PresetId, type Prioridade } from '@tela/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Aviso } from '../components/Aviso.js';
import { Botao } from '../components/Botao.js';
import { Cabecalho } from '../components/Cabecalho.js';
import { CapturePreview } from '../components/CapturePreview.js';
import { Dialogo } from '../components/Dialogo.js';
import { DiagnosticoConteudo } from '../components/DiagnosticoConteudo.js';
import { VidroCrt } from '../components/EfeitosTv.js';
import { FaixaLink } from '../components/FaixaLink.js';
import { FilaDePedidos } from '../components/FilaDePedidos.js';
import { BotoesDoCabecalho } from '../components/BotoesDoCabecalho.js';
import { TesteDeRede } from '../components/TesteDeRede.js';
import { Led } from '../components/Led.js';
import { Medidor } from '../components/Medidor.js';
import { AbasDeResolucao } from '../components/AbasDeResolucao.js';
import { MenuOsd, type LinhaMenu } from '../components/MenuOsd.js';
import { PainelOsd } from '../components/PainelOsd.js';
import type { Vaga } from '../components/SalaVagas.js';
import {
  createBroadcastSession,
  identity,
  ofereceApp,
  sondaDeRede,
  volumeTransmissaoPreference,
  audioCue,
} from '../container.js';
import type { BroadcastFailure } from '../core/media/broadcast-session.js';
import { useAutoHide } from '../react/use-auto-hide.js';
import { useAvisosAoVivo } from '../react/use-avisos-ao-vivo.js';
import { useBipeDePedido } from '../react/use-bipe-de-pedido.js';
import { useBroadcast } from '../react/use-broadcast.js';
import { useCopia } from '../react/use-copia.js';
import { useDiagnostico } from '../react/use-diagnostico.js';
import { useDialogo } from '../react/use-dialogo.js';
import { BLOCOS_DO_TESTE, medidaDaConexaoDireta, useTesteDeRede } from '../react/use-teste-de-rede.js';
import { useResumoDaTransmissao } from '../react/use-resumo-da-transmissao.js';
import { FimDeTransmissao } from '../components/FimDeTransmissao.js';
import { isPresetId } from '../core/media/presets.js';
import { ModalApp } from './ModalApp.js';
import { useMediaStats } from '../react/use-media-stats.js';
import { useMenuOsd } from '../react/use-menu-osd.js';
import { useBeforeUnload, useTabTitle, useWakeLock } from '../react/use-page-effects.js';
import { useTempoNoAr } from '../react/use-tempo-no-ar.js';
import { useVolumeTransmissao } from '../react/use-volume-transmissao.js';

type Props = {
  readonly slug: string;
  readonly presetId: PresetId;
  /** Só usado no Linux, onde o áudio do sistema não vem com a tela. */
  readonly audioDeviceId: string | null;
  /** 60 fps (fluidez) ou 30 fps (nitidez), escolhido no passo 02. */
  readonly prioridade: Prioridade;
  readonly onExit: () => void;
};

/**
 * `Record<BroadcastFailure, string>`, não `Record<string, string>`: um motivo
 * novo na união quebra a compilação aqui, em vez de deixar o usuário cair
 * silenciosamente num texto genérico.
 */
const MOTIVOS: Record<BroadcastFailure, string> = {
  CAPTURE_DENIED: 'Você cancelou o compartilhamento de tela, ou o navegador não tem permissão para capturá-la.',
  CAPTURE_FAILED:
    'O navegador não conseguiu capturar a tela — não foi escolha sua. Tente de novo; se repetir, feche outros programas que estejam gravando ou compartilhando a tela.',
  CAPTURE_UNSUPPORTED:
    'Este navegador não permite capturar a tela. Use Chrome ou Firefox no desktop.',
  CAPTURE_ENDED: 'O compartilhamento de tela foi encerrado.',
  SLUG_TAKEN: 'Esse link já está sendo usado por outra pessoa. Escolha outro nome.',
  SLUG_INVALID: 'Esse nome de link não é válido.',
  RATE_LIMITED: 'Muitas tentativas. Espere um minuto.',
  OUTDATED: 'O Tela foi atualizado desde que esta página abriu. Recarregue e transmita de novo.',
  SIGNALING_UNAVAILABLE: 'Não foi possível falar com o servidor de sinalização.',
  TRANSPORT_FAILED: 'A conexão de vídeo caiu.',
  USER_STOPPED: 'Transmissão encerrada.',
};

/** Rótulo do degrau para o resumo da tela de fim. Estável: vive fora do componente. */
const rotuloDoPresetId = (id: string): string =>
  isPresetId(id) ? PRESETS[id].label.replace(' econômico', ' eco') : id;

/** O único motivo que não é falha. Todo o resto merece o tom de alerta. */
const ENCERRAMENTO_NORMAL: BroadcastFailure = 'USER_STOPPED';

/**
 * Onde tentar de novo AQUI resolve (TELA-013). Nome ocupado ou inválido pede
 * outro nome, que se escolhe no início; navegador sem captura não muda com
 * insistência. O resto recomeça sem recarregar a página — e o clique é o
 * gesto que o seletor de tela exige.
 */
const REPETIVEL: ReadonlySet<BroadcastFailure> = new Set<BroadcastFailure>([
  'CAPTURE_DENIED',
  'CAPTURE_FAILED',
  'CAPTURE_ENDED',
  'RATE_LIMITED',
  'SIGNALING_UNAVAILABLE',
  'TRANSPORT_FAILED',
]);

const AJUDA_PRIORIDADE = {
  fluidez:
    'Segura os 60 fps e deixa a imagem borrar nas cenas rápidas. É o certo para gameplay, onde o movimento é a informação.',
  nitidez:
    'Segura a resolução e deixa os quadros caírem, para 30 fps. Certo quando o detalhe é a informação: mapa, inventário, texto.',
} as const;

const IDS_BASE = ['resolucao', 'rede'] as const;

/** O teclado do menu fica no invólucro das abas + linhas; ver o painel. */
const SEM_TECLADO = { onKeyDown: () => undefined };

/**
 * O console de quem transmite.
 *
 * # A regra desta tela
 *
 * **Console quando tem alguém aqui, plaqueta quando não tem.** O corpo da
 * página some junto com o cabeçalho e no lugar fica uma plaqueta — LED AO VIVO,
 * o link e a contagem — porque quem captura a tela inteira está mandando esta
 * página para os amigos junto com o jogo. Deixar um console denso
 * permanentemente aceso seria transformar a tela deles num painel de
 * controle. Ao primeiro movimento do mouse tudo volta.
 *
 * Não há animação em JS aqui, nem laço contínuo: a troca é `opacity` em CSS, que
 * roda no compositor; o único relógio é o do "NO AR", e ele só tiqueia com o
 * console à vista. Esta página convive com um jogo na mesma máquina.
 *
 * # Ordem dos hooks
 *
 * TODOS os hooks vêm antes dos `return` antecipados. Dois deles já foram
 * declarados depois de `if (!live) return …`, e o resultado foi "Rendered more
 * hooks than during the previous render" no instante em que a pessoa apertava
 * TRANSMITIR. `rules-of-hooks` no lint pega isso agora.
 */
export function Broadcast({ slug, presetId, audioDeviceId, prioridade: prioridadeInicial, onExit }: Props) {
  const session = useMemo(() => createBroadcastSession(), []);
  const {
    state,
    start,
    stop,
    setPreset,
    switchSource,
    setPrioridade,
    setVolumeTransmissao,
    retomarAudio,
    desconectarTodos,
    aceitarPedido,
    recusarPedido,
    pausar,
    retomar,
  } = useBroadcast(session);
  /** Pausa de privacidade: manter o som é exceção explícita, desligada. */
  const [pausaComSom, setPausaComSom] = useState(false);

  const live = state.status === 'live';
  const vivo = state.status === 'live' ? state : null;

  const som = useVolumeTransmissao(volumeTransmissaoPreference, setVolumeTransmissao);
  // A preferência guardada precisa alcançar o grafo assim que ele existe.
  useEffect(() => {
    if (live) setVolumeTransmissao(som.volume);
  }, [live, som.volume, setVolumeTransmissao]);

  // Aberta por padrão: transmitir às cegas é o que produz "achei que estava
  // funcionando". O usuário fecha se atrapalhar.
  const [previewAberto, setPreviewAberto] = useState(true);
  const [diagAberto, setDiagAberto] = useState(false);
  const [focoNoConsole, setFocoNoConsole] = useState(false);

  /**
   * O console some sozinho, e não some enquanto está sendo OPERADO — que aqui
   * quer dizer: foco de teclado dentro dele, ou o diagnóstico aberto. Passar o
   * mouse por cima não fixa: `useAutoHide` já rearma o relógio em qualquer
   * `mousemove`. E clique NÃO fixa, de propósito: quem sai para o jogo com
   * alt-tab não move o ponteiro, e um console preso aceso vai junto com a tela
   * capturada para os amigos.
   */
  const hud = useAutoHide(5_000, live && !focoNoConsole && !diagAberto);
  const stats = useMediaStats(live ? state.stats : null);
  const tempo = useTempoNoAr(live, hud.visible);
  const avisos = useAvisosAoVivo(vivo, stats.warning);
  const diagnostico = useDiagnostico(vivo, stats);
  const link = useCopia(1_500);
  const diagCopia = useCopia(2_000);
  const dialogo = useDialogo(diagAberto, useCallback(() => setDiagAberto(false), []));
  const teste = useTesteDeRede(sondaDeRede);
  const resumo = useResumoDaTransmissao(state, rotuloDoPresetId);
  const [appAberto, setAppAberto] = useState(false);
  const fecharApp = useCallback(() => setAppAberto(false), []);

  /*
    Pedidos para assistir (ADR 0025): quem transmite está no jogo, com esta aba
    atrás. O bipe chama; o contador no título diz quantos esperam.
  */
  const pedidos = vivo?.pedidos ?? [];
  // Os ids viram uma chave de texto dentro do hook: array novo por render não re-dispara.
  useBipeDePedido(pedidos.map((p) => p.peerId), audioCue.bipe);
  useTabTitle(
    live ? `${pedidos.length > 0 ? `(${pedidos.length}) ` : ''}● No ar · Tela` : 'Tela',
  );
  useWakeLock(live);
  useBeforeUnload(live, () => void session.stop('USER_STOPPED'));

  // Copiar o link ao iniciar remove um passo inteiro do fluxo principal: o
  // usuário sai daqui direto para o Ctrl+V no Discord.
  const copiarLink = link.copiar;
  useEffect(() => session.on('started', ({ shareUrl }) => copiarLink(shareUrl)), [session, copiarLink]);


  /**
   * Inicia ao montar, encerra ao desmontar.
   *
   * NÃO há guarda de "já iniciou". React em StrictMode monta, desmonta e monta
   * de novo; com a guarda, o segundo mount encontrava a sessão já encerrada pelo
   * cleanup do primeiro e não reiniciava. `start()` já sai cedo se a sessão não
   * estiver ociosa, então re-executar é seguro. As dependências são só valores
   * estáveis: se uma ação do hook entrar aqui sem ser estável, o cleanup passa a
   * rodar a cada render e derruba a transmissão.
   *
   * O encerramento espera um tique (TELA-026). Sem isso, o remonte do
   * StrictMode encerrava a primeira sessão no meio do `getDisplayMedia` e a
   * segunda pedia a captura de novo — medido: dois seletores de tela do
   * sistema a cada TRANSMITIR em desenvolvimento. Remonte imediato com os
   * mesmos parâmetros cancela o encerramento e a sessão em curso segue; com
   * parâmetros diferentes, encerra na hora e começa outra, como antes.
   */
  const encerrarAdiado = useRef<{ readonly chave: string; readonly timer: number } | null>(null);
  useEffect(() => {
    const chave = JSON.stringify([slug, presetId, audioDeviceId, prioridadeInicial]);
    const adiado = encerrarAdiado.current;
    if (adiado !== null) {
      window.clearTimeout(adiado.timer);
      encerrarAdiado.current = null;
      if (adiado.chave !== chave) void session.stop('USER_STOPPED');
    }
    // Sessão já em curso (remonte): `start` sai cedo sozinho.
    void start(slug, identity.ownerToken(), presetId, audioDeviceId, prioridadeInicial);
    return () => {
      encerrarAdiado.current = {
        chave,
        timer: window.setTimeout(() => {
          encerrarAdiado.current = null;
          void session.stop('USER_STOPPED');
        }, 0),
      };
    };
  }, [session, start, slug, presetId, audioDeviceId, prioridadeInicial]);

  const handleStop = useCallback(() => {
    // Só pergunta se tem gente assistindo. Confirmar quando o usuário está
    // sozinho é atrito puro.
    if (vivo !== null && vivo.peers.length > 0) {
      const ok = window.confirm(`${vivo.peers.length} pessoa(s) assistindo. Encerrar mesmo assim?`);
      if (!ok) return;
    }
    void stop();
  }, [vivo, stop]);

  /** Ver `core/media/diagnostico.ts`. Nada sai da máquina sozinho. */
  const copiarDiag = diagCopia.copiar;
  const copiarDiagnostico = useCallback(() => {
    const relatorio = session.diagnostico(navigator.userAgent);
    if (relatorio === null) return;
    copiarDiag(JSON.stringify(relatorio, null, 2));
  }, [session, copiarDiag]);

  /* ─────────────── o menu de ajuste rápido ─────────────── */

  const presetAtual = vivo?.presetId ?? presetId;
  /** O que a pessoa escolheu; as setas andam a partir DAQUI, não do que a rede segurou. */
  const presetEscolhido = vivo?.presetEscolhido ?? presetId;
  const prioridade = vivo?.prioridade ?? 'fluidez';
  const temAudio = vivo?.hasAudio ?? false;
  const ids = useMemo(() => (temAudio ? [...IDS_BASE, 'volume'] : [...IDS_BASE]), [temAudio]);

  const ajustar = useCallback(
    (id: string, direcao: -1 | 1) => {
      if (id === 'resolucao') {
        const i = PRESET_ORDER.indexOf(presetEscolhido);
        // Sem dar a volta: ao vivo, "←" em 1080p não pode cair em 360p por acidente.
        const proximo = PRESET_ORDER[Math.min(PRESET_ORDER.length - 1, Math.max(0, i + direcao))];
        if (proximo !== undefined && proximo !== presetEscolhido) void setPreset(proximo);
      } else if (id === 'rede') {
        void setPrioridade(prioridade === 'fluidez' ? 'nitidez' : 'fluidez');
      } else if (id === 'volume') {
        som.definir(Math.round((som.volume + direcao * 0.1) * 10) / 10);
      }
    },
    [presetEscolhido, prioridade, setPreset, setPrioridade, som],
  );

  const menu = useMenuOsd({ ids, aoAjustar: ajustar });

  /* ─────────────── estados que não são "ao vivo" ─────────────── */

  if (state.status === 'ended') {
    const falhou = state.reason !== ENCERRAMENTO_NORMAL;
    const relatorio = session.diagnostico(navigator.userAgent);
    const recomecar = () =>
      void start(slug, identity.ownerToken(), presetId, audioDeviceId, prioridadeInicial);
    return (
      <div className="flex min-h-dvh flex-col bg-void">
        <VidroCrt />
        <Cabecalho marcaHref="/" />
        <main className="flex flex-1 items-center justify-center p-4 sm:p-8">
          <FimDeTransmissao
            falhou={falhou}
            titulo={falhou ? 'SEM SINAL' : 'FIM DA TRANSMISSÃO'}
            mensagem={
              falhou
                ? (MOTIVOS[state.reason] ?? 'A transmissão caiu.')
                : 'Seus amigos já não recebem imagem. O link continua seu: é só transmitir de novo.'
            }
            canal={`${window.location.host}/${slug}`}
            resumo={
              resumo === null
                ? null
                : [
                    { rotulo: 'TEMPO NO AR', valor: resumo.tempoNoAr, tom: 'destaque' },
                    {
                      rotulo: 'PICO DE AMIGOS',
                      valor: String(resumo.pico),
                      nota:
                        resumo.pico === 0
                          ? 'ninguém entrou desta vez'
                          : resumo.pico === 1
                            ? 'assistindo ao mesmo tempo'
                            : 'assistindo juntos',
                    },
                    { rotulo: 'ÚLTIMA QUALIDADE', valor: resumo.qualidade },
                  ]
            }
            acoes={
              <>
                {(!falhou || REPETIVEL.has(state.reason)) && (
                  <Botao
                    tom="primaria"
                    grande
                    onClick={recomecar}
                    icone={<span aria-hidden="true" className="h-3 w-3 bg-[#b3261a] shadow-[inset_0_0_0_2px_#14100a]" />}
                  >
                    {falhou ? 'TENTAR DE NOVO' : 'TRANSMITIR DE NOVO'}
                  </Botao>
                )}
                <Botao grande onClick={onExit}>
                  VOLTAR AO INÍCIO
                </Botao>
              </>
            }
            diagnostico={
              relatorio === null ? null : (
                <details className="w-full border-2 border-line bg-surface text-[12px] text-muted">
                  <summary className="flex min-h-11 cursor-pointer items-center px-4">
                    ver diagnóstico da tentativa
                  </summary>
                  <div className="flex flex-col gap-3 border-t-2 border-line p-4">
                    <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-all bg-deep p-3 text-[11px]">
                      {JSON.stringify(relatorio, null, 2)}
                    </pre>
                    <div>
                      <Botao onClick={copiarDiagnostico}>
                        {diagCopia.copiado ? 'COPIADO' : 'COPIAR DIAGNÓSTICO'}
                      </Botao>
                    </div>
                  </div>
                </details>
              )
            }
          />
        </main>
      </div>
    );
  }

  if (vivo === null) {
    const pedindoTela = state.status === 'requesting-capture';
    return (
      <Moldura>
        <PainelOsd titulo={pedindoTela ? 'ESCOLHA O QUE TRANSMITIR' : 'ABRINDO O CANAL'}>
          <div className="flex flex-col gap-4 p-5" role="status">
            <p className="m-0 flex items-center gap-3 text-[14px] text-text">
              <Led cor="ok" pisca />
              {pedindoTela
                ? 'Escolha a tela ou a janela do jogo na caixa do navegador.'
                : `Reservando tela.gg/${slug} e abrindo a conexão…`}
            </p>
            <p className="m-0 max-w-[52ch] text-[12px] leading-relaxed text-muted [text-wrap:pretty]">
              {pedindoTela
                ? 'Prefira "Tela inteira": é o único modo em que o áudio do sistema acompanha o vídeo, e é o caminho mais barato para a sua placa.'
                : 'Se o nome já estiver em uso, você volta para a tela inicial com o aviso: nada é enviado antes disso.'}
            </p>
          </div>
        </PainelOsd>
      </Moldura>
    );
  }

  /* ─────────────── ao vivo ─────────────── */

  const conectados = vivo.peers.filter((p) => p.connectionState === 'connected').length;
  const viaRelay = vivo.peers.filter((p) => p.usingRelay).length;

  const vagas: readonly Vaga[] = Array.from({ length: vivo.maxPeers }, (_, i): Vaga => {
    const peer = vivo.peers[i];
    const n = String(i + 1).padStart(2, '0');
    if (peer === undefined) return { n, nome: null, estado: '—', tom: 'vazio' };
    // O apelido que a pessoa deu ao pedir; sem ele (cliente antigo), o número.
    const nome = vivo.nomes[peer.id]?.toUpperCase() ?? `ESPECTADOR ${i + 1}`;
    if (peer.connectionState !== 'connected') return { n, nome, estado: 'CONECTANDO', tom: 'alerta' };
    return peer.usingRelay
      ? { n, nome, estado: 'VIA TURN', tom: 'alerta' }
      : { n, nome, estado: 'ASSISTINDO', tom: 'ok' };
  });

  const escolhido = PRESETS[presetEscolhido];
  const rotuloCurto = (id: PresetId) => PRESETS[id].label.replace(' econômico', ' eco');
  const ajudaResolucao = [
    `${escolhido.width}×${escolhido.height}. ~${(escolhido.main.maxBitrate / 1_000_000).toFixed(1).replace('.', ',')} Mbps de subida por espectador.`,
    vivo.presetForced
      ? vivo.motivoDegradacao === 'cpu'
        ? `A máquina não estava dando conta e está saindo ${rotuloCurto(presetAtual)}. Fechar programas pesados ajuda.`
        : `O link está segurando em ${rotuloCurto(presetAtual)}; sobe sozinho quando a rede abrir.`
      : '',
  ]
    .filter((t) => t !== '')
    .join(' ');

  const linhas: readonly LinhaMenu[] = [
    {
      id: 'rede',
      tipo: 'ciclo',
      rotulo: 'SE A REDE APERTAR',
      valor: prioridade.toUpperCase(),
      indice: prioridade === 'fluidez' ? 0 : 1,
      total: 2,
      ajuda: AJUDA_PRIORIDADE[prioridade],
    },
    ...(temAudio
      ? [
          {
            id: 'volume',
            tipo: 'barra' as const,
            rotulo: 'VOLUME QUE OS AMIGOS OUVEM',
            valor: Math.round(som.volume * 100),
            ajuda: vivo.volumeAjustavel
              ? 'Só muda o que chega para eles. O seu som continua igual.'
              : 'Este navegador não deixa ajustar o volume da transmissão. O som sai como o sistema entregou.',
          },
        ]
      : []),
  ];

  return (
    <div
      className="relative flex min-h-dvh flex-col bg-void lg:h-dvh lg:overflow-hidden"
      onMouseMove={hud.show}
      onFocusCapture={(event) => {
        /**
         * `:focus-visible`, e não `focus` cru. Clique de mouse TAMBÉM foca, e
         * nada desfaz um foco: qualquer clique em "copiar link" travava o
         * console aceso para sempre — e ele vai junto com o jogo na captura.
         * `:focus-visible` é a heurística do navegador para "chegou por
         * teclado", o único caso em que esconder seria hostil.
         */
        const alvo = event.target as HTMLElement;
        setFocoNoConsole(typeof alvo.matches === 'function' && alvo.matches(':focus-visible'));
      }}
      onBlurCapture={() => setFocoNoConsole(false)}
    >
      <VidroCrt />
      {/*
        A plaqueta: o que resta quando ninguém está mexendo. Não é decoração —
        é o estado de repouso do aparelho, e é o que os amigos veem se o
        transmissor deixar esta aba visível durante a captura de tela cheia.
      */}
      <div
        aria-hidden={hud.visible}
        className={[
          'pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 transition-opacity duration-300',
          hud.visible ? 'animacoes-pausadas opacity-0' : 'opacity-100',
        ].join(' ')}
      >
        <span className="flex items-center gap-2.5 font-[family-name:var(--font-pixel)] text-[13px] text-danger">
          <Led pisca />
          NO AR
        </span>
        <p className="numeral m-0 text-[clamp(30px,5vw,56px)] text-accent-hi [text-shadow:0_0_18px_rgb(242_169_59_/_0.4)]">
          {vivo.shareUrl.replace(/^https?:\/\//, '')}
        </p>
        <p className="m-0 text-[13px] text-muted">
          {conectados} de {vivo.maxPeers} assistindo · {stats.rtt}
        </p>
        {/*
          Só a contagem, nunca os nomes: esta placa é o que vai na captura se a
          aba ficar visível. A fila com os botões aparece ao mexer o mouse.
        */}
        {pedidos.length > 0 && (
          <p className="m-0 flex items-center gap-2 font-[family-name:var(--font-pixel)] text-[12px] text-accent-hi">
            <Led cor="ok" pisca />
            {pedidos.length === 1 ? '1 PEDIDO PARA ASSISTIR' : `${pedidos.length} PEDIDOS PARA ASSISTIR`}
          </p>
        )}
      </div>

      <div
        className={[
          'flex min-h-0 flex-1 flex-col transition-opacity duration-300',
          hud.visible ? 'opacity-100' : 'animacoes-pausadas opacity-0',
        ].join(' ')}
      >
        <Cabecalho>
          <span className="flex min-h-9 items-center gap-2 border-2 border-danger-edge bg-[#2a0f0b] px-2.5 font-[family-name:var(--font-pixel)] text-[12px] text-danger">
            <Led pisca />
            NO AR
            <span className="tabular hidden sm:inline">{tempo}</span>
          </span>
          <BotoesDoCabecalho aoDiagnostico={() => setDiagAberto(true)} aoBaixarApp={ofereceApp ? () => setAppAberto(true) : undefined} />
        </Cabecalho>

        {/*
          Tela inteira, como no protótipo: a coluna da esquerda é link + prévia
          ocupando toda a altura; a da direita é o painel de ajuste de cima a
          baixo, com as ações presas embaixo. Sem largura máxima — numa tela
          larga o que cresce é a prévia, que é o que importa ver.
        */}
        <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex min-h-0 min-w-0 flex-col gap-3 p-3 sm:p-4">
            <FaixaLink
              link={vivo.shareUrl}
              novo={link.copiado}
              copiado={link.copiado}
              aoCopiar={() => copiarLink(vivo.shareUrl)}
              vagas={vagas}
              total={vivo.maxPeers}
              ocupadas={vivo.peers.length}
            />

            <FilaDePedidos pedidos={pedidos} aoAceitar={aceitarPedido} aoRecusar={recusarPedido} />

            {avisos.map((aviso) => (
              <Aviso key={aviso.chave} tom="alerta" anuncia>
                {aviso.texto}
              </Aviso>
            ))}

            {/*
              `aberto={previewAberto && hud.visible}`: opacidade zero NÃO para o
              vídeo — medido, 30 quadros por segundo continuavam sendo
              entregues a um elemento invisível, na máquina que roda o jogo.
            */}
            <div className="min-h-[240px] flex-1">
              <CapturePreview
                stream={vivo.preview}
                aberto={previewAberto && hud.visible}
                onToggle={() => setPreviewAberto((v) => !v)}
                semSinal={vivo.capturaSemImagem}
                tempoNoAr={tempo}
                oculto={vivo.pausa !== null}
              />
            </div>
            <p className="m-0 text-[11px] leading-relaxed text-dim">
              Fechar esta aba encerra a transmissão; deixá-la atrás do jogo, não.
            </p>
          </div>

          <aside className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto border-t-2 border-line p-3 sm:p-4 lg:border-l-2 lg:border-t-0">
            <PainelOsd titulo="AJUSTE RÁPIDO" direita={menu.posicao} className="flex-1">
              {/*
                O teclado do menu vale para as abas e para as linhas: um só
                `onKeyDown`, aqui em volta — o MenuOsd recebe um inerte para o
                evento não ser tratado duas vezes na subida.
              */}
              <div {...menu.propsContainer}>
                <AbasDeResolucao
                  opcoes={PRESET_ORDER.map((id) => ({ id, rotulo: rotuloCurto(id) }))}
                  escolhido={presetEscolhido}
                  noAr={vivo.presetForced ? presetAtual : null}
                  ajuda={ajudaResolucao}
                  aoEscolher={(id) => {
                    const alvo = PRESET_ORDER.find((p) => p === id);
                    if (alvo !== undefined) void setPreset(alvo);
                  }}
                  propsGrupo={menu.propsLinha('resolucao')}
                />
                <MenuOsd
                  rotulo="Ajustes ao vivo"
                  linhas={linhas}
                  ativo={menu.ativo}
                  propsContainer={SEM_TECLADO}
                  propsLinha={menu.propsLinha}
                  aoAjustar={ajustar}
                  aoDefinirBarra={(_, pct) => som.definir(pct / 100)}
                  aoSelecionar={menu.selecionar}
                />
              </div>

              {/*
                Grafo suspenso: a trilha continua `live` e sai SILÊNCIO. Só um
                clique retoma — `resume()` fora de gesto é recusado.
              */}
              {(vivo.grafoAudio === 'suspenso' || vivo.grafoAudio === 'interrompido') && (
                <div className="px-3 pb-3">
                  <Botao bloco tom="primaria" onClick={() => void retomarAudio()}>
                    ATIVAR ÁUDIO DA TRANSMISSÃO
                  </Botao>
                </div>
              )}

              <Medidor
                rotulo="Números da transmissão agora"
                colunas={2}
                tamanho="p"
                medidas={[
                  { rotulo: 'SAI DO ENCODER', valor: stats.resolution },
                  {
                    rotulo: 'QUADROS',
                    valor: stats.fps,
                    tom: vivo.presetForced || stats.encoderLento ? 'alerta' : 'neutro',
                  },
                  { rotulo: 'SOBE AGORA', valor: stats.bitrate, tom: 'destaque' },
                  { rotulo: 'PIOR LATÊNCIA', valor: stats.rtt, tom: viaRelay > 0 ? 'alerta' : 'neutro' },
                  {
                    rotulo: 'DENSIDADE',
                    valor: stats.qp === '—' ? stats.bpp : `${stats.bpp} · QP ${stats.qp}`,
                    tom: stats.bppBaixo || stats.qpAlto ? 'alerta' : 'neutro',
                  },
                  {
                    rotulo: 'CODIFICA',
                    valor: stats.msPorQuadro === '—' ? stats.encoder : stats.msPorQuadro,
                    tom: stats.encoderLento ? 'alerta' : 'neutro',
                  },
                ]}
              />

              {/* Ações presas embaixo, como no protótipo. */}
              <div className="flex-1" />
              <div className="flex flex-col gap-2 border-t-2 border-line p-3.5">
                {/*
                  Pausa de privacidade (TELA-022): os amigos veem o quadro
                  "transmissão pausada" no lugar da tela, sem perder a sala.
                  Não é encerrar — a captura continua, e voltar é instantâneo.
                */}
                {vivo.pausa === null ? (
                  <div className="flex flex-col gap-1.5">
                    <Botao onClick={() => void pausar({ manterSom: pausaComSom })}>
                      OCULTAR TRANSMISSÃO
                    </Botao>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[11px] text-muted">
                      <input
                        type="checkbox"
                        checked={pausaComSom}
                        onChange={(e) => setPausaComSom(e.target.checked)}
                      />
                      manter o som enquanto oculto
                    </label>
                  </div>
                ) : (
                  <>
                    <p role="status" className="m-0 text-[12px] leading-relaxed text-warn">
                      Oculta: seus amigos veem "transmissão pausada"
                      {vivo.pausa.comSom ? ', e ainda ouvem o som.' : ', sem som.'} O que já tinha
                      saído antes do clique não volta.
                    </p>
                    <Botao tom="primaria" onClick={() => void retomar()}>
                      VOLTAR A MOSTRAR
                    </Botao>
                  </>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Botao onClick={() => void switchSource()}>TROCAR FONTE</Botao>
                  <Botao tom="perigo" onClick={handleStop}>
                    <span aria-hidden="true" className="h-2 w-2 bg-live-hi" />
                    ENCERRAR
                  </Botao>
                </div>
              </div>
            </PainelOsd>

            {/*
              Quem entra: sala aberta (ADR 0028) — quem tem o link assiste.
              Desconectar todos tira quem está dentro; quem tiver o link pode
              voltar.
            */}
            <PainelOsd titulo="SALA ▸ QUEM ENTRA">
              <div className="flex flex-col gap-3 p-3.5">
                <p className="m-0 text-[12px] leading-relaxed text-muted [text-wrap:pretty]">
                  Quem tem o link entra direto, até {vivo.maxPeers} pessoas. Mande só para quem
                  você quer: desconectar todos tira todo mundo, mas quem tiver o link pode voltar.
                </p>
                {vivo.peers.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <Botao tom="perigo" onClick={desconectarTodos}>
                      DESCONECTAR TODOS
                    </Botao>
                  </div>
                )}
              </div>
            </PainelOsd>
          </aside>
        </main>
      </div>

      <Dialogo
        titulo="DIAGNÓSTICO ▸ REDE E CONEXÕES"
        dialogRef={dialogo.ref}
        aoClicar={dialogo.aoClicar}
        aoFechar={() => setDiagAberto(false)}
      >
        {diagnostico !== null && (
          <DiagnosticoConteudo
            resumo={[...diagnostico.resumo, medidaDaConexaoDireta(teste)]}
            espectadores={diagnostico.espectadores}
            audio={diagnostico.audio}
            copiado={diagCopia.copiado}
            aoCopiar={copiarDiagnostico}
            teste={
              <TesteDeRede
                testando={teste.fase === 'testando'}
                blocos={teste.blocos}
                total={BLOCOS_DO_TESTE}
                aoTestar={teste.testar}
              />
            }
          />
        )}
      </Dialogo>
      <ModalApp aberto={appAberto} aoFechar={fecharApp} />
    </div>
  );
}

/**
 * A moldura dos estados que não são "ao vivo": o mesmo cabeçalho e o mesmo
 * painel de menu do resto do produto, no centro da tela. Aqui a marca NÃO é
 * link — sair pelo cabeçalho no meio de uma tentativa perderia o estado.
 */
function Moldura({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-void">
      <VidroCrt />
      <Cabecalho />
      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <div className="w-full max-w-[620px]">{children}</div>
      </main>
    </div>
  );
}
