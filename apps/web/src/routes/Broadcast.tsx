import { PRESETS, PRESET_ORDER, type PresetId } from '@tela/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BigButton } from '../components/BigButton.js';
import { CapturePreview } from '../components/CapturePreview.js';
import { LiveDot } from '../components/LiveDot.js';
import { LiveHud } from '../components/LiveHud.js';
import { Panel, PanelSection } from '../components/Panel.js';
import { QualityPicker } from '../components/QualityPicker.js';
import { SignalChain } from '../components/SignalChain.js';
import { ViewerSlots } from '../components/ViewerSlots.js';
import { VolumeControl } from '../components/VolumeControl.js';
import {
  createBroadcastSession,
  identity,
  volumeTransmissaoPreference,
} from '../container.js';
import type { EstadoAudio } from '../core/media/audio-state.js';
import type { BroadcastFailure } from '../core/media/broadcast-session.js';
import { useAutoHide } from '../react/use-auto-hide.js';
import { useBroadcast } from '../react/use-broadcast.js';
import { useMediaStats } from '../react/use-media-stats.js';
import { useBeforeUnload, useTabTitle, useWakeLock } from '../react/use-page-effects.js';

type Props = {
  readonly slug: string;
  readonly presetId: PresetId;
  /** Só usado no Linux, onde o áudio do sistema não vem com a tela. */
  readonly audioDeviceId: string | null;
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

/**
 * Só os estados do som que pedem ação de quem transmite.
 *
 * `mudo` foi escolha dele, `sem-fonte` já tem aviso próprio quando custou o
 * áudio (`audioPerdidoPelaEscolha`), e perda é medida do lado de quem recebe.
 * Trocar a fonte NÃO recaptura o som — a troca preserva a trilha de áudio de
 * propósito —, então o texto não pode sugerir isso.
 */
const AVISO_AUDIO: Partial<Record<EstadoAudio, string>> = {
  bloqueado:
    'O navegador pausou o áudio da transmissão — os amigos estão ouvindo silêncio. Use "ativar áudio da transmissão" no painel.',
  encerrada:
    'O som da captura acabou — os amigos estão sem áudio. Pare e comece de novo para capturá-lo outra vez.',
  'sem-sinal':
    'Nenhum som saindo há 20 segundos. Se o jogo está tocando, confira a fonte de áudio escolhida.',
};

/**
 * O console de quem transmite.
 *
 * # O problema que esta tela tinha
 *
 * Um painel amontoado no topo, que sumia sozinho em cinco segundos, e mais
 * nada — duas linhas de texto cinza ancoradas no rodapé para não ficarem
 * atrás do painel. Todo o resto da tela era preto. A informação que responde
 * "meus amigos estão vendo?" e "está bom?" existia, mas espremida a 12px
 * dentro do elemento que desaparece.
 *
 * # A regra desta tela agora
 *
 * **Console quando tem alguém aqui, plaqueta quando não tem.**
 *
 * O corpo da página some junto com o HUD e no lugar fica uma plaqueta — LED
 * AO VIVO, o link e a contagem — porque quem captura a tela inteira está
 * mandando esta página para os amigos junto com o jogo. Deixar um console
 * denso permanentemente aceso seria transformar a tela deles num painel de
 * controle. Ao primeiro movimento do mouse tudo volta.
 *
 * Não há animação em JS aqui, nem laço contínuo: a troca é `opacity` em CSS,
 * que roda no compositor. Esta página convive com um jogo na mesma máquina.
 *
 * # Sobreposição do painel: resolvida na estrutura, não com `padding`
 *
 * O remendo anterior empurrava o texto para `pb-[14vh]` porque o HUD era
 * `fixed` e cobria o centro a 1366×768. O HUD agora é `sticky` em fluxo:
 * ocupa a própria altura e não cobre nada, em altura de tela nenhuma, com
 * qualquer quantidade de avisos abertos.
 */
export function Broadcast({ slug, presetId, audioDeviceId, onExit }: Props) {
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
    renovarConvite: renovarConviteDaSessao,
    desconectarTodos,
  } = useBroadcast(session);

  /**
   * Volume da transmissão, lembrado entre sessões.
   *
   * Quem abaixou para conversar na call ontem espera que continue abaixado
   * hoje — reaplicar 100% a cada transmissão devolveria o susto.
   */
  const [volumeAudio, setVolumeAudio] = useState(() => {
    /**
     * O `null` PRECISA ser tratado antes do `Number`.
     *
     * `Number(null)` é 0, não `NaN` — e 0 passa numa guarda de intervalo
     * `>= 0 && <= 1`. Sem preferência guardada, ou seja, na PRIMEIRA
     * transmissão de todo mundo, o volume nascia em zero: o produto mandava
     * silêncio aos amigos e o botão dizia "Ativar o som", como se o usuário
     * tivesse escolhido isso.
     */
    const guardado = volumeTransmissaoPreference.read();
    if (guardado === null) return 1;
    const bruto = Number(guardado);
    return Number.isFinite(bruto) && bruto >= 0 && bruto <= 1 ? bruto : 1;
  });

  const aplicarVolume = useCallback(
    (valor: number) => {
      setVolumeAudio(valor);
      volumeTransmissaoPreference.write(valor.toFixed(2));
      setVolumeTransmissao(valor);
    },
    [setVolumeTransmissao],
  );

  // A preferência guardada precisa alcançar o grafo assim que ele existe.
  useEffect(() => {
    if (state.status === 'live') setVolumeTransmissao(volumeAudio);
  }, [state.status, volumeAudio, setVolumeTransmissao]);
  const [copied, setCopied] = useState(false);
  // Aberto por padrão: transmitir às cegas é o que produz "achei que estava
  // funcionando". O usuário fecha se atrapalhar.
  const [previewAberto, setPreviewAberto] = useState(true);

  const live = state.status === 'live';

  /**
   * O HUD e o console somem juntos, e nenhum dos dois some enquanto está
   * sendo OPERADO.
   *
   * "Operado" é a palavra exata, e ela custou uma iteração: a primeira versão
   * fixava o console no `pointerenter`, e o resultado é que soltar o mouse em
   * cima dele — que é onde o mouse fica depois de clicar em TRANSMITIR —
   * segurava tudo aceso para sempre. Quem sai para o jogo com alt-tab não move
   * o ponteiro, então nenhum `pointerleave` chega e a página fica ligada
   * mandando o console para os amigos junto com o jogo.
   *
   * O que fixa, então:
   *
   * - foco de teclado dentro do console (`focusin`/`focusout`), senão quem
   *   tabula perde de vista o controle que acabou de alcançar;
   * - o controle de volume reportando uso próprio, que é o caso do arraste:
   *   segurar o cursor parado num valor por cinco segundos é normal, e é
   *   exatamente o defeito que `onAtivo` existe para evitar.
   *
   * Passar o mouse por cima NÃO fixa — não precisa: `useAutoHide` já rearma o
   * relógio em qualquer `mousemove`. Enquanto a pessoa está de fato mexendo,
   * o movimento sozinho mantém tudo visível.
   *
   * O HUD continua com o par ponteiro/foco dele, intocado. Lá é uma barra
   * fina, e ela nunca fica debaixo do cursor por acidente.
   */
  const [mexendoNoHud, setMexendoNoHud] = useState(false);
  const [focoNoConsole, setFocoNoConsole] = useState(false);
  const [mexendoNoVolume, setMexendoNoVolume] = useState(false);
  const emUso = mexendoNoHud || focoNoConsole || mexendoNoVolume;

  const hud = useAutoHide(5_000, live && !emUso);
  const presets = useMemo(() => PRESET_ORDER.map((id) => PRESETS[id]), []);
  const stats = useMediaStats(live ? state.stats : null);

  useTabTitle(live ? `● tela.gg/${slug}` : 'tela');
  useWakeLock(live);
  useBeforeUnload(live, () => void session.stop('USER_STOPPED'));

  const copy = useCallback((url: string) => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => undefined);
  }, []);

  // Copiar o link ao iniciar remove um passo inteiro do fluxo principal: o
  // usuário sai daqui direto para o Ctrl+V no Discord.
  useEffect(() => session.on('started', ({ shareUrl }) => copy(shareUrl)), [session, copy]);

  /**
   * Renovar já copia o link novo: é a única coisa que se faz com ele em
   * seguida. A resposta do servidor decide o texto — "renovado" só quando ele
   * confirmou.
   */
  const [convite, setConvite] = useState<'parado' | 'renovado' | 'falhou'>('parado');
  const renovarConvite = useCallback(async () => {
    const confirmado = await renovarConviteDaSessao();
    const atual = session.getState();
    if (atual.status === 'live') copy(atual.shareUrl);
    setConvite(confirmado ? 'renovado' : 'falhou');
    window.setTimeout(() => setConvite('parado'), 3_000);
  }, [renovarConviteDaSessao, session, copy]);

  /**
   * Inicia ao montar, encerra ao desmontar.
   *
   * NÃO há guarda de "já iniciou". React em StrictMode monta, desmonta e monta
   * de novo; com a guarda, o segundo mount encontrava a sessão já encerrada
   * pelo cleanup do primeiro e não reiniciava — o usuário via "Transmissão
   * encerrada" sem nada ter acontecido. `start()` já sai cedo se a sessão não
   * estiver ociosa, então re-executar é seguro.
   *
   * As dependências são só valores estáveis. Se uma ação do hook entrar aqui
   * sem ser estável, o cleanup passa a rodar a cada render e derruba a
   * transmissão — foi exatamente esse o bug.
   */
  useEffect(() => {
    void start(slug, identity.ownerToken(), presetId, audioDeviceId);
    return () => {
      void session.stop('USER_STOPPED');
    };
  }, [session, start, slug, presetId, audioDeviceId]);

  const handleStop = useCallback(() => {
    // Só pergunta se tem gente assistindo. Confirmar quando o usuário está
    // sozinho é atrito puro.
    if (live && state.peers.length > 0) {
      const ok = window.confirm(
        `${state.peers.length} pessoa(s) assistindo. Encerrar mesmo assim?`,
      );
      if (!ok) return;
    }
    void stop();
  }, [live, state, stop]);

  /**
   * ANTES dos early returns, e a posição é o ponto.
   *
   * Estes dois hooks estavam declarados depois de `if (!live) return …`, o que
   * é violação de ordem de hooks: enquanto a transmissão não começa o
   * componente registra N hooks, e no instante em que ela começa registra N+2.
   * React responde com "Rendered more hooks than during the previous render" e
   * derruba o console — exatamente quando a pessoa aperta TRANSMITIR.
   *
   * Passou no lint porque `eslint-plugin-react-hooks` não estava instalado.
   * Agora está.
   */
  const [copiouDiag, setCopiouDiag] = useState(false);

  /** Ver `core/media/diagnostico.ts`. Nada sai da máquina sozinho. */
  const copiarDiagnostico = useCallback(() => {
    const relatorio = session.diagnostico(navigator.userAgent);
    if (relatorio === null) return;
    void navigator.clipboard
      .writeText(JSON.stringify(relatorio, null, 2))
      .then(() => {
        setCopiouDiag(true);
        setTimeout(() => setCopiouDiag(false), 2_000);
      })
      .catch(() => undefined);
  }, [session]);

  if (state.status === 'ended') {
    const falhou = state.reason !== ENCERRAMENTO_NORMAL;
    const relatorio = session.diagnostico(navigator.userAgent);
    return (
      <Moldura>
        <PanelSection rotulo={falhou ? 'não deu para transmitir' : 'transmissão encerrada'}>
          <div className="flex flex-col items-start gap-5 py-4">
            <p className={`text-[17px] leading-relaxed ${falhou ? 'text-warn' : 'text-text'}`}>
              {MOTIVOS[state.reason] ?? 'Transmissão encerrada.'}
            </p>
            {relatorio !== null && (
              <details className="w-full max-w-2xl text-[13px] text-muted">
                <summary className="cursor-pointer">ver diagnóstico da tentativa</summary>
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface p-3 text-[11px]">
                  {JSON.stringify(relatorio, null, 2)}
                </pre>
                <button type="button" onClick={copiarDiagnostico} className="mt-2 underline">
                  {copiouDiag ? 'copiado' : 'copiar diagnóstico'}
                </button>
              </details>
            )}
            <div className="flex flex-wrap gap-3">
              {REPETIVEL.has(state.reason) && (
                <BigButton
                  onClick={() => void start(slug, identity.ownerToken(), presetId, audioDeviceId)}
                >
                  tentar de novo
                </BigButton>
              )}
              <BigButton onClick={onExit} tone="ghost">
                voltar para o início
              </BigButton>
            </div>
          </div>
        </PanelSection>
      </Moldura>
    );
  }

  if (!live) {
    const pedindoTela = state.status === 'requesting-capture';
    return (
      <Moldura>
        <PanelSection rotulo={pedindoTela ? 'escolha o que transmitir' : 'abrindo o canal'}>
          <div className="flex flex-col gap-4 py-4">
            <p className="text-[17px] text-text">
              {pedindoTela
                ? 'Escolha a tela ou a janela do jogo na caixa do navegador.'
                : 'Reservando tela.gg/' + slug + ' e abrindo a conexão…'}
            </p>
            <p className="max-w-[52ch] text-[13px] leading-relaxed text-muted">
              {pedindoTela
                ? 'Prefira "Tela inteira": é o único modo em que o áudio do sistema acompanha o vídeo, e é o caminho mais barato para a sua placa.'
                : 'Se o nome já estiver em uso, você volta para a tela inicial com o aviso — nada é enviado antes disso.'}
            </p>
            <span
              className="mt-1 h-[2px] w-full max-w-[220px] overflow-hidden rounded-full bg-line"
              aria-hidden="true"
            >
              <span className="animate-scan block h-full w-1/5 bg-gradient-to-r from-transparent via-text to-transparent" />
            </span>
          </div>
        </PanelSection>
      </Moldura>
    );
  }

  const shareUrl = state.shareUrl;
  const conectados = state.peers.filter((p) => p.connectionState === 'connected').length;
  const conectando = state.peers.length - conectados;
  const relayed = state.peers.filter((peer) => peer.usingRelay).length;

  /**
   * O diagnóstico do momento, silenciado quando a degradação já aconteceu.
   *
   * `presetForced` explica a mesma coisa com mais detalhe e com o que fazer a
   * respeito. Mostrar os dois juntos daria "CPU no limite — reduzindo
   * qualidade" logo acima de "Qualidade reduzida — o encode está pesando na
   * máquina": o mesmo aviso, duas vezes, em dois tons diferentes.
   */
  const avisoMomentaneo = state.presetForced ? null : stats.warning;

  /**
   * O mesmo desenho da tela inicial, com os números MEDIDOS no lugar dos
   * previstos — e ele É a leitura da transmissão, não uma ilustração ao lado
   * dela.
   *
   * Uma versão intermediária tinha uma seção "ENVIANDO" com resolução,
   * quadros, subida e latência em grade, E este caminho logo abaixo com os
   * mesmos quatro números. Escrever a mesma coisa duas vezes na mesma tela é
   * pior do que não escrever: obriga o leitor a conferir se são iguais. A
   * grade saiu; ficou o caminho, que já dá aos números o que faltava — rótulo,
   * corpo legível e a posição em que cada um acontece.
   *
   * Nada é calculado aqui: os quatro já vinham de `useMediaStats`.
   */
  const caminho = [
    {
      // Era rotulado como "resolução que a captura entrega", e não é: o número
      // vem do `outbound-rtp`, ou seja, do que o ENCODER produz depois de toda
      // adaptação. A diferença entre os dois é justamente onde a imagem se
      // perdia sem ninguém ver.
      rotulo: 'sai do encoder',
      valor: stats.resolution,
      nota: 'resolução real chegando nos espectadores',
    },
    {
      rotulo: 'seu PC codifica',
      valor: stats.fps,
      /*
        `encoderImplementation` não existe no caminho de captura de tela —
        medimos: o campo só aparece enquanto há câmera ou microfone vivos. O
        substituto é o custo por quadro, que sempre existe: acima de 16,7ms o
        encoder não faz 60fps, e isso é quase sempre software.
      */
      nota:
        stats.msPorQuadro === '—'
          ? 'quadros por segundo saindo do encoder'
          : `${stats.msPorQuadro} por quadro no encoder${stats.encoderLento ? ' — não dá conta de 60fps' : ''}`,
      alerta: state.presetForced || stats.encoderLento,
    },
    {
      rotulo: 'sobe direto',
      valor: stats.bitrate,
      nota: 'total somado sobre todos os espectadores',
    },
    {
      /*
        O número que prevê a imagem borrada ANTES de ela aparecer.

        Abaixo de 0,10 bit por pixel em movimento alto o encoder não tem saída
        além de subir o QP, e logo depois o navegador começa a derrubar
        resolução por conta própria. Era a única grandeza do pipeline que
        ninguém media — e a que estava em 0,024 quando o produto anunciava
        1080p60 (ADR 0015).
      */
      rotulo: 'densidade',
      valor: stats.qp === '—' ? stats.bpp : `${stats.bpp} · QP ${stats.qp}`,
      /*
        O bpp sempre foi um PROXY para "o QP fica abaixo de 37" — é em 37 que o
        quality scaler do Chromium começa a derrubar resolução sozinho
        (`kHighH264QpThreshold`, escala 0–51). O QP é a variável de verdade, e
        ele vem no mesmo `getStats()` que já coletamos por segundo.
      */
      nota:
        stats.qp === '—'
          ? 'bits por pixel por espectador — abaixo de 0,10 a imagem borra'
          : 'bits por pixel e QP do encoder — acima de 37 o navegador corta resolução',
      alerta: stats.bppBaixo || stats.qpAlto,
    },
    {
      rotulo: 'chega nos amigos',
      valor: stats.rtt,
      nota: 'pior latência entre eles — o melhor esconderia quem está mal',
      alerta: relayed > 0,
    },
  ];

  return (
    <main className="relative flex min-h-dvh flex-col" onMouseMove={hud.show}>
      <LiveHud
        shareUrl={shareUrl}
        viewers={state.peers.length}
        maxPeers={state.maxPeers}
        semSinalizacao={state.semSinalizacao}
        semSinal={state.capturaSemImagem}
        audioPerdidoPelaEscolha={state.audioPerdidoPelaEscolha}
        avisoAudio={AVISO_AUDIO[state.audio] ?? null}
        presetForced={state.presetForced}
        motivoDegradacao={state.motivoDegradacao}
        aviso={avisoMomentaneo}
        onSwitchSource={() => void switchSource()}
        copied={copied}
        onCopy={() => copy(shareUrl)}
        onStop={handleStop}
        visible={hud.visible}
        onInteracao={setMexendoNoHud}
        reconnecting={state.peers.some((p) => p.connectionState === 'disconnected')}
      />

      <div className="relative flex flex-1 items-center px-3 pb-4 pt-3 sm:px-5 sm:pb-6">
        {/*
          A plaqueta: o que resta quando ninguém está mexendo. Não é decoração
          — é o estado de repouso do aparelho, e é o que os amigos veem se o
          transmissor deixar esta aba visível durante a captura de tela cheia.
        */}
        <div
          aria-hidden={hud.visible}
          className={[
            'pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3',
            'transition-opacity duration-300',
            hud.visible ? 'opacity-0' : 'opacity-100',
          ].join(' ')}
        >
          <LiveDot />
          <p className="tabular text-[clamp(20px,3.4vw,30px)] text-text">
            {shareUrl.replace(/^https?:\/\//, '')}
          </p>
          <p className="tabular text-[13px] text-muted">
            {conectados} de {state.maxPeers} assistindo · {stats.rtt}
          </p>
        </div>

        <div
          onFocusCapture={(event) => {
            /**
             * `:focus-visible`, e não `focus` cru.
             *
             * Clique de mouse TAMBÉM foca, e nada desfaz um foco: qualquer
             * clique em "copiar link" ou num preset travava o painel aceso
             * para sempre — e ele é capturado junto com o jogo em tela cheia.
             * `:focus-visible` é a heurística do próprio navegador para
             * "chegou aqui pelo teclado", que é o único caso em que esconder
             * seria hostil.
             */
            const alvo = event.target as HTMLElement;
            setFocoNoConsole(typeof alvo.matches === 'function' && alvo.matches(':focus-visible'));
          }}
          onBlurCapture={() => setFocoNoConsole(false)}
          className={[
            'mx-auto w-full max-w-[1180px] transition-opacity duration-300',
            hud.visible ? 'opacity-100' : 'opacity-0',
          ].join(' ')}
        >
          <Panel>
            <div className="flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:items-stretch">
              {/*
                `justify-center`: a coluna esticada pela coluna de
                instrumentos ficava com um vazio pendurado embaixo do botão de
                ocultar. Centrado, o vazio vira margem em volta da prévia.
              */}
              <PanelSection
                rotulo="o que seus amigos estão vendo"
                className="flex flex-col justify-center py-4"
              >
                {/*
                  `hud.visible &&` não é redundante com a opacidade do console.
                  Opacidade zero NÃO para o vídeo: medido, 30 quadros por
                  segundo continuavam sendo entregues a um elemento invisível,
                  na máquina que está rodando o jogo. É o mesmo custo que já
                  tinha sido removido de um `<video>` 1×1 escondido, de volta
                  em tamanho de coluna.
                */}
                <CapturePreview
                  stream={state.preview}
                  aberto={previewAberto && hud.visible}
                  onToggle={() => setPreviewAberto((v) => !v)}
                  semSinal={state.capturaSemImagem}
                />
              </PanelSection>

              <div className="flex flex-col border-t border-line lg:border-l lg:border-t-0">
                <PanelSection rotulo="qualidade" className="py-4">
                  <div className="flex flex-col gap-3">
                    <QualityPicker
                      presets={presets}
                      value={state.presetId}
                      onChange={(id) => void setPreset(id)}
                      compact
                    />

                    <div className="flex flex-col gap-2">
                      <p className="serigrafia">se a rede apertar</p>
                      <div
                        className="flex items-center gap-1 rounded-md border border-edge bg-void p-1"
                        role="group"
                        aria-label="O que priorizar quando a rede apertar"
                      >
                        {(['fluidez', 'nitidez'] as const).map((opcao) => (
                          <button
                            key={opcao}
                            type="button"
                            onClick={() => void setPrioridade(opcao)}
                            aria-pressed={state.prioridade === opcao}
                            title={
                              opcao === 'fluidez'
                                ? 'Segura os 60fps e deixa borrar. Certo para gameplay.'
                                : 'Segura a resolução e deixa o framerate cair. Certo quando o detalhe importa.'
                            }
                            className={[
                              'min-h-11 flex-1 rounded-sm px-2.5 text-[12px] transition-colors duration-150',
                              state.prioridade === opcao
                                ? 'bg-text font-medium text-void'
                                : 'text-muted hover:bg-surface hover:text-text',
                            ].join(' ')}
                          >
                            {opcao}
                          </button>
                        ))}
                      </div>
                      <p className="text-[12px] leading-relaxed text-muted">
                        {state.prioridade === 'fluidez'
                          ? 'Segura os 60fps e deixa a imagem borrar nas cenas rápidas. É o certo para gameplay, onde o movimento é a informação.'
                          : 'Segura a resolução e deixa o framerate cair. Certo quando o detalhe é a informação — mapa, inventário, texto.'}
                      </p>
                    </div>
                  </div>
                </PanelSection>

                {/*
                  O rótulo é metade da correção, não enfeite. Quem transmite
                  abaixava o alto-falante e o som continuava alto para os
                  amigos — a captura do sistema pega o stream ANTES do volume
                  de saída do aparelho, então aquele controle nunca teve efeito
                  sobre a transmissão. Dizer "que os amigos ouvem" resolve a
                  confusão; a barra dá o poder que faltava.
                */}
                {state.hasAudio && (
                  <PanelSection rotulo="volume que os amigos ouvem" className="border-t border-line py-4">
                    <VolumeControl
                      volume={volumeAudio}
                      mudo={volumeAudio === 0}
                      ajustavel={state.volumeAjustavel}
                      ativo
                      onVolume={aplicarVolume}
                      onAlternar={() => aplicarVolume(volumeAudio === 0 ? 1 : 0)}
                      passo={0.05}
                      onAtivo={setMexendoNoVolume}
                    />
                    {/*
                      Grafo suspenso: a trilha continua `live` e sai silêncio.
                      Só um clique retoma — `resume()` fora de gesto é recusado.
                    */}
                    {(state.grafoAudio === 'suspenso' || state.grafoAudio === 'interrompido') && (
                      <div className="mt-3">
                        <BigButton tone="ghost" onClick={() => void retomarAudio()}>
                          ativar áudio da transmissão
                        </BigButton>
                      </div>
                    )}
                    {!state.volumeAjustavel && (
                      <p className="mt-2 text-[12px] leading-relaxed text-muted">
                        Este navegador não deixa ajustar o volume da transmissão. O som sai como
                        o sistema entregou.
                      </p>
                    )}
                  </PanelSection>
                )}

                <PanelSection rotulo="espectadores" className="border-t border-line py-4">
                  <div className="flex flex-col gap-2">
                    <ViewerSlots
                      total={state.maxPeers}
                      conectados={conectados}
                      viaRelay={relayed}
                      conectando={conectando}
                    />
                    <p className="text-[12px] leading-relaxed text-muted">
                      Direto do seu PC para o deles. Fechar esta aba encerra a transmissão —
                      deixá-la atrás do jogo não.
                    </p>
                  </div>
                </PanelSection>

                {/*
                  Convite (TELA-018): duas ações, porque são duas decisões.
                  Renovar barra quem tem o link velho e deixa quem já está
                  dentro; desconectar tira quem está dentro, que pode voltar
                  pelo mesmo link enquanto ele não for renovado.
                */}
                <PanelSection rotulo="convite" className="border-t border-line py-4">
                  <div className="flex flex-col gap-3">
                    <p className="text-[12px] leading-relaxed text-muted">
                      Só entra quem tem o link completo. Renovar gera um link novo: o antigo
                      para de funcionar para quem chegar depois.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <BigButton tone="ghost" onClick={() => void renovarConvite()}>
                        {convite === 'renovado'
                          ? 'link novo copiado'
                          : convite === 'falhou'
                            ? 'servidor não confirmou — tente de novo'
                            : 'renovar convite'}
                      </BigButton>
                      {state.peers.length > 0 && (
                        <BigButton tone="danger" onClick={desconectarTodos}>
                          desconectar todos
                        </BigButton>
                      )}
                    </div>
                  </div>
                </PanelSection>
              </div>
            </div>

            <div className="border-t border-line bg-surface px-4 py-4 sm:px-6">
              <SignalChain rotulo="caminho do vídeo agora" nodes={caminho} />

              {/*
                A série temporal, para mandar em vez de descrever. Nada sai da
                máquina sozinho — isto copia, a pessoa decide se manda.
              */}
              <button
                type="button"
                onClick={copiarDiagnostico}
                className="mt-3 self-start rounded-sm px-2 py-1 text-[12px] text-faint transition-colors duration-150 hover:bg-surface hover:text-muted"
              >
                {copiouDiag ? 'diagnóstico copiado' : 'copiar diagnóstico técnico'}
              </button>
            </div>
          </Panel>
        </div>
      </div>
    </main>
  );
}

/**
 * A moldura dos estados que não são "ao vivo".
 *
 * Eram três telas de texto solto centralizado, cada uma com uma composição
 * própria. Passar todas pela mesma chapa que a tela inicial e o console usam é
 * o que faz o produto parecer um produto, e não quatro páginas parecidas.
 */
function Moldura({ children }: { readonly children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8 sm:px-6">
      <Panel className="w-full max-w-[620px]">{children}</Panel>
    </main>
  );
}
