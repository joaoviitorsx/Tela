import { PRESETS, PRESET_ORDER, type PresetId } from '@tela/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BigButton } from '../components/BigButton.js';
import { LiveHud } from '../components/LiveHud.js';
import { createBroadcastSession, identity } from '../container.js';
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
  CAPTURE_DENIED: 'Você cancelou o compartilhamento de tela.',
  CAPTURE_UNSUPPORTED:
    'Este navegador não permite capturar a tela. Use Chrome ou Firefox no desktop.',
  CAPTURE_ENDED: 'O compartilhamento de tela foi encerrado.',
  SLUG_TAKEN: 'Esse link já está sendo usado por outra pessoa. Escolha outro nome.',
  SLUG_INVALID: 'Esse nome de link não é válido.',
  RATE_LIMITED: 'Muitas tentativas. Espere um minuto.',
  SIGNALING_UNAVAILABLE: 'Não foi possível falar com o servidor de sinalização.',
  TRANSPORT_FAILED: 'A conexão de vídeo caiu.',
  USER_STOPPED: 'Transmissão encerrada.',
};

export function Broadcast({ slug, presetId, audioDeviceId, onExit }: Props) {
  const session = useMemo(() => createBroadcastSession(), []);
  const { state, start, stop, setPreset } = useBroadcast(session);
  const [copied, setCopied] = useState(false);

  const live = state.status === 'live';
  const hud = useAutoHide(5_000, live);
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

  if (state.status === 'ended') {
    return (
      <main className="flex min-h-full flex-col items-center justify-center gap-6 px-6 text-center">
        <p className="text-[17px]">{MOTIVOS[state.reason] ?? 'Transmissão encerrada.'}</p>
        <BigButton onClick={onExit} tone="ghost">
          voltar
        </BigButton>
      </main>
    );
  }

  if (!live) {
    return (
      <main className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[15px] text-muted">
          {state.status === 'requesting-capture'
            ? 'Escolha a tela ou a janela do jogo…'
            : 'Conectando…'}
        </p>
        <span
          className="h-1.5 w-24 overflow-hidden rounded-full bg-edge/40"
          aria-hidden="true"
        >
          <span className="block h-full w-1/3 animate-live rounded-full bg-muted" />
        </span>
      </main>
    );
  }

  const shareUrl = state.shareUrl;

  return (
    <main
      className="relative min-h-full"
      onMouseMove={hud.show}
    >
      <LiveHud
        shareUrl={shareUrl}
        viewers={state.peers.length}
        maxPeers={state.maxPeers}
        relayed={state.peers.filter((peer) => peer.usingRelay).length}
        audioPerdidoPelaEscolha={state.audioPerdidoPelaEscolha}
        semSinalizacao={state.semSinalizacao}
        copied={copied}
        onCopy={() => copy(shareUrl)}
        onStop={handleStop}
        visible={hud.visible}
        reconnecting={state.peers.some((p) => p.connectionState === 'disconnected')}
        presets={presets}
        presetId={state.presetId}
        presetForced={state.presetForced}
        onPreset={(id) => void setPreset(id)}
        stats={stats}
      />

      <div className="flex min-h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="tabular text-[15px] text-muted">
          transmitindo — seu jogo está indo para {shareUrl.replace(/^https?:\/\//, '')}
        </p>
        <p className="max-w-sm text-[13px] text-muted">
          Não precisa manter esta página visível. Ela só não pode ser fechada.
        </p>
      </div>
    </main>
  );
}
