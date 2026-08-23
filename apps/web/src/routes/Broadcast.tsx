import { PRESETS, PRESET_ORDER, type PresetId } from '@tela/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BigButton } from '../components/BigButton.js';
import { LiveHud } from '../components/LiveHud.js';
import { createBroadcastSession, identity } from '../container.js';
import { useAutoHide } from '../react/use-auto-hide.js';
import { useBroadcast } from '../react/use-broadcast.js';
import { useMediaStats } from '../react/use-media-stats.js';
import { useBeforeUnload, useTabTitle, useWakeLock } from '../react/use-page-effects.js';

type Props = {
  readonly slug: string;
  readonly presetId: PresetId;
  readonly onExit: () => void;
};

const MOTIVOS: Record<string, string> = {
  CAPTURE_DENIED: 'Você cancelou o compartilhamento de tela.',
  CAPTURE_UNSUPPORTED: 'Este navegador não permite capturar a tela. Use Chrome ou Firefox no desktop.',
  CAPTURE_ENDED: 'O compartilhamento de tela foi encerrado.',
  OWNER_INVALID: 'Este link não é seu neste navegador.',
  UPSTREAM_UNAVAILABLE: 'O servidor de mídia não respondeu.',
  TRANSPORT_FAILED: 'A conexão de vídeo caiu.',
  USER_STOPPED: 'Transmissão encerrada.',
};

export function Broadcast({ slug, presetId, onExit }: Props) {
  const session = useMemo(() => createBroadcastSession(), []);
  const { state, start, stop, setPreset } = useBroadcast(session);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  const live = state.status === 'live';
  const reconnecting = state.status === 'reconnecting';
  const hud = useAutoHide(5_000, live);
  const presets = useMemo(() => PRESET_ORDER.map((id) => PRESETS[id]), []);
  const stats = useMediaStats(live ? state.stats : null);

  useTabTitle(live || reconnecting ? `● tela.gg/${slug}` : 'tela');
  useWakeLock(live);
  useBeforeUnload(live || reconnecting, () => void session.stop('USER_STOPPED'));

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

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start(slug, identity.ownerToken(), presetId);
    return () => {
      void session.stop('USER_STOPPED');
    };
  }, [session, start, slug, presetId]);

  const handleStop = useCallback(() => {
    // Só pergunta se tem gente assistindo. Confirmar quando o usuário está
    // sozinho é atrito puro.
    if (live && state.viewers > 0) {
      const ok = window.confirm(`${state.viewers} pessoa(s) assistindo. Encerrar mesmo assim?`);
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

  if (!live && !reconnecting) {
    return (
      <main className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[15px] text-dim">
          {state.status === 'requesting-capture'
            ? 'Escolha a tela ou a janela do jogo…'
            : 'Conectando…'}
        </p>
        <span
          className="h-1.5 w-24 overflow-hidden rounded-full bg-line"
          aria-hidden="true"
        >
          <span className="block h-full w-1/3 animate-live rounded-full bg-accent" />
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
        viewers={live ? state.viewers : 0}
        copied={copied}
        onCopy={() => copy(shareUrl)}
        onStop={handleStop}
        visible={hud.visible || reconnecting}
        reconnecting={reconnecting}
        transport={live ? state.transport : 'sfu'}
        presets={presets}
        presetId={live ? state.presetId : presetId}
        presetForced={live ? state.presetForced : false}
        onPreset={(id) => void setPreset(id)}
        stats={stats}
      />

      <div className="flex min-h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="tabular text-[15px] text-dim">
          transmitindo — seu jogo está indo para {shareUrl.replace(/^https?:\/\//, '')}
        </p>
        <p className="max-w-sm text-[13px] text-muted">
          Não precisa manter esta página visível. Ela só não pode ser fechada.
        </p>
      </div>
    </main>
  );
}
