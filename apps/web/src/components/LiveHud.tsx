import type { EncodingPreset, PresetId, Prioridade } from '@tela/shared';
import { useEffect, useState } from 'react';
import { CapturePreview } from './CapturePreview.js';
import { IconCheck, IconCopy, IconStop, IconViewers, IconWarning } from './Icon.js';
import { LiveDot } from './LiveDot.js';
import { QualityPicker } from './QualityPicker.js';
import { StatsBadge } from './StatsBadge.js';
import { VolumeControl } from './VolumeControl.js';

/** O painel do transmissor não se auto-oculta por causa do volume. */
const SEM_AUTO_OCULTAR = (): void => undefined;

type Props = {
  readonly shareUrl: string;
  readonly viewers: number;
  /** Teto do canal. Mostrar `2/3` diz mais que `2` — o usuário sabe quanto falta. */
  readonly maxPeers: number;
  /** Quantos espectadores estão passando por TURN. */
  readonly relayed: number;
  /** Escolheu janela em vez de tela inteira, e o áudio do sistema ficou de fora. */
  readonly audioPerdidoPelaEscolha: boolean;
  /** Existe trilha de áudio sendo transmitida. */
  readonly hasAudio: boolean;
  /** Volume do que os ESPECTADORES ouvem — não o alto-falante de quem transmite. */
  readonly volumeAudio: number;
  readonly volumeAjustavel: boolean;
  readonly onVolumeAudio: (valor: number) => void;
  /** Canal de sinalização caiu: quem assiste continua, ninguém novo entra. */
  readonly semSinalizacao: boolean;
  /** A mídia capturada, para quem transmite conferir o que está mandando. */
  readonly preview: MediaStream | null;
  readonly previewAberto: boolean;
  readonly onTogglePreview: () => void;
  /** A captura parou de produzir imagem. Vale com o preview aberto ou fechado. */
  readonly semSinal: boolean;
  readonly onSemSinal: (semSinal: boolean) => void;
  readonly onSwitchSource: () => void;
  readonly prioridade: Prioridade;
  readonly onPrioridade: (p: Prioridade) => void;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onStop: () => void;
  readonly visible: boolean;
  /** Ponteiro em cima ou foco dentro: o HUD não pode sumir enquanto se usa. */
  readonly onInteracao: (ativo: boolean) => void;
  readonly reconnecting: boolean;
  readonly presets: readonly EncodingPreset[];
  readonly presetId: PresetId;
  readonly presetForced: boolean;
  readonly onPreset: (id: PresetId) => void;
  readonly stats: {
    readonly resolution: string;
    readonly fps: string;
    readonly bitrate: string;
    readonly rtt: string;
    readonly warning: string | null;
  };
};

/**
 * HUD no canto superior. Nunca cobre o centro.
 *
 * O link JÁ foi copiado ao iniciar — o botão existe para a segunda vez. Some
 * depois de 5s e volta no mousemove, porque o que está embaixo é o jogo.
 */
export function LiveHud({
  shareUrl,
  viewers,
  maxPeers,
  relayed,
  audioPerdidoPelaEscolha,
  hasAudio,
  volumeAudio,
  volumeAjustavel,
  onVolumeAudio,
  semSinalizacao,
  preview,
  previewAberto,
  onTogglePreview,
  semSinal,
  onSemSinal,
  onSwitchSource,
  prioridade,
  onPrioridade,
  copied,
  onCopy,
  onStop,
  visible,
  onInteracao,
  reconnecting,
  presets,
  presetId,
  presetForced,
  onPreset,
  stats,
}: Props) {
  /**
   * Ponteiro e foco são condições INDEPENDENTES — um booleano só faria o
   * último evento apagar o outro, e o painel sumiria debaixo do cursor. Mesmo
   * defeito que já apareceu no controle de volume; não repetir.
   */
  const [comPonteiro, setComPonteiro] = useState(false);
  const [comFoco, setComFoco] = useState(false);

  useEffect(() => {
    onInteracao(comPonteiro || comFoco);
  }, [comPonteiro, comFoco, onInteracao]);

  return (
    <div
      onPointerEnter={() => setComPonteiro(true)}
      onPointerLeave={() => setComPonteiro(false)}
      onFocusCapture={() => setComFoco(true)}
      onBlurCapture={() => setComFoco(false)}
      className={[
        'pointer-events-none fixed inset-x-0 top-0 z-20 p-3 sm:p-4',
        'transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
    >
      <div className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-2 rounded-md border border-edge bg-surface/95 p-3 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {reconnecting ? <LiveDot label="RECONECTANDO" tone="warn" /> : <LiveDot />}

          <button
            type="button"
            onClick={onCopy}
            className="tabular group inline-flex min-h-8 items-center gap-2 rounded-sm px-2 text-[13px] text-text transition-colors duration-150 hover:bg-void"
          >
            {shareUrl.replace(/^https?:\/\//, '')}
            {copied ? (
              <IconCheck className="h-3.5 w-3.5 text-text" />
            ) : (
              <IconCopy className="h-3.5 w-3.5 text-muted group-hover:text-text" />
            )}
            <span className="sr-only">{copied ? 'link copiado' : 'copiar link'}</span>
          </button>

          <span className="tabular inline-flex items-center gap-1.5 text-[13px] text-muted">
            <IconViewers className="h-4 w-4" />
            {viewers}/{maxPeers}
            <span className="sr-only">
              {viewers === 1 ? 'espectador' : 'espectadores'} de {maxPeers}
            </span>
          </span>

          {relayed > 0 && (
            <span
              className="tabular text-[12px] text-warn"
              title="Conexão indireta, via servidor de relay: latência maior e cota consumida."
            >
              {relayed} via relay
            </span>
          )}

          <span className="ml-auto flex items-center gap-3">
            <StatsBadge {...stats} />
            <button
              type="button"
              onClick={onSwitchSource}
              title="Escolher outra tela ou janela sem derrubar quem está assistindo"
              className="inline-flex min-h-8 items-center rounded-sm border border-edge px-2.5 text-[13px] text-muted transition-colors duration-150 hover:border-text hover:text-text"
            >
              trocar tela
            </button>
            <button
              type="button"
              onClick={onStop}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-edge px-2.5 text-[13px] text-muted transition-colors duration-150 hover:border-danger hover:text-danger"
            >
              <IconStop className="h-3 w-3" />
              parar
            </button>
          </span>
        </div>

        <div className="border-t border-line pt-2">
          <CapturePreview
            stream={preview}
            aberto={previewAberto}
            onToggle={onTogglePreview}
            onSemSinal={onSemSinal}
          />

          {/*
            Com o preview ABERTO o aviso já cobre a imagem; repetir aqui seria
            dizer duas vezes. Fechado, esta é a única evidência de que a
            transmissão está preta — e sem ela a tela inteira dizia
            "transmitindo" enquanto ninguém via nada.
          */}
          {semSinal && !previewAberto && (
            <p role="status" className="mt-1.5 flex items-center gap-1.5 text-[12px] text-warn">
              <IconWarning className="h-3.5 w-3.5 shrink-0" />
              A captura não está produzindo imagem — os amigos estão vendo preto.
              Pare e escolha a tela de novo.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
          <QualityPicker
            presets={presets}
            value={presetId}
            onChange={onPreset}
            compact
          />

          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="O que priorizar quando a rede apertar"
          >
            {(['fluidez', 'nitidez'] as const).map((opcao) => (
              <button
                key={opcao}
                type="button"
                onClick={() => onPrioridade(opcao)}
                aria-pressed={prioridade === opcao}
                title={
                  opcao === 'fluidez'
                    ? 'Segura os 60fps e deixa borrar. Certo para gameplay.'
                    : 'Segura a resolução e deixa o framerate cair. Certo quando o detalhe importa.'
                }
                className={[
                  'min-h-8 rounded-sm px-2.5 text-[12px] transition-colors duration-150',
                  prioridade === opcao
                    ? 'bg-text font-medium text-void'
                    : 'text-muted hover:bg-void hover:text-text',
                ].join(' ')}
              >
                {opcao}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-muted">
            direto do seu PC — fechar esta aba encerra a transmissão
          </span>
        </div>

        {presetForced && (
          <p role="status" className="text-[12px] text-warn">
            Qualidade reduzida automaticamente — o encoder não estava dando conta.
          </p>
        )}

        {semSinalizacao && (
          <p role="status" className="flex items-center gap-1.5 text-[12px] text-warn">
            <IconWarning className="h-3.5 w-3.5 shrink-0" />
            Servidor fora do ar. Quem já está assistindo continua vendo — mas
            ninguém novo consegue entrar pelo link.
          </p>
        )}

        {/*
          O rótulo é a correção, não o controle.

          Quem transmite abaixava o alto-falante e o som continuava alto para
          os amigos — e concluía, com razão, que o produto estava inconsistente.
          A captura do sistema pega o stream ANTES do volume de saída do
          aparelho, então aquele controle nunca teve efeito sobre a
          transmissão. Dizer "que os amigos ouvem" resolve a confusão; a barra
          só dá o poder que faltava.
        */}
        {hasAudio && (
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-[12px] text-muted">volume que os amigos ouvem</span>
            <VolumeControl
              volume={volumeAudio}
              mudo={volumeAudio === 0}
              ajustavel={volumeAjustavel}
              ativo
              onVolume={onVolumeAudio}
              onAlternar={() => onVolumeAudio(volumeAudio === 0 ? 1 : 0)}
              passo={0.05}
              onAtivo={SEM_AUTO_OCULTAR}
            />
          </div>
        )}

        {hasAudio && !volumeAjustavel && (
          <p className="text-[12px] text-muted">
            Este navegador não deixa ajustar o volume da transmissão. O som sai
            como o sistema entregou.
          </p>
        )}

        {audioPerdidoPelaEscolha && (
          <p role="status" className="flex items-center gap-1.5 text-[12px] text-warn">
            <IconWarning className="h-3.5 w-3.5 shrink-0" />
            Sem áudio: o som do sistema só acompanha a tela inteira. Pare e
            escolha "Tela inteira" no seletor.
          </p>
        )}
      </div>
    </div>
  );
}
