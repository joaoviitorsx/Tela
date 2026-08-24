import { useEffect, useRef } from 'react';
import { IconWarning } from './Icon.js';

type Props = {
  readonly stream: MediaStream | null;
  readonly aberto: boolean;
  readonly onToggle: () => void;
  /** Vem da sessão, medido no encoder. O componente não diagnostica nada. */
  readonly semSinal: boolean;
};

/**
 * O que está sendo capturado, do lado de quem transmite.
 *
 * Serve como confirmação — ninguém deveria transmitir às cegas — e como
 * DIAGNÓSTICO. Sem ele, "está preto" tem duas causas indistinguíveis: a
 * captura não produziu frame nenhum, ou produziu e a rede não entregou.
 *
 * Mudo, sempre. Tocar o áudio do jogo de volta nos alto-falantes de quem está
 * jogando cria eco, e o navegador ainda pode capturar esse eco de volta.
 *
 * Ao capturar a tela inteira o preview mostra a si mesmo, em recursão. É
 * inevitável, é o mesmo comportamento do OBS, e na prática é o sinal visual
 * mais rápido de que a captura de tela inteira está funcionando.
 *
 * # Desmonta quando fecha, e isso é intencional
 *
 * Uma versão anterior mantinha o vídeo montado como 1×1 invisível para seguir
 * detectando captura morta com o preview fechado. Funcionava e custava caro no
 * único lugar onde não se pode cobrar: a máquina que está rodando o jogo
 * continuava compondo frames para um elemento que ninguém vê.
 *
 * A detecção passou para `framesPerSecond` do `outbound-rtp`, que a sessão já
 * amostrava de qualquer forma — de graça, e medindo o que os espectadores de
 * fato recebem em vez do que um elemento local acha.
 */
export function CapturePreview({ stream, aberto, onToggle, semSinal }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (element === null || stream === null || !aberto) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    void element.play().catch(() => undefined);
  }, [stream, aberto]);

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={aberto}
        className="flex items-center gap-2 self-start text-[12px] text-muted transition-colors duration-150 hover:text-text"
      >
        <span className={`inline-block transition-transform duration-150 ${aberto ? 'rotate-90' : ''}`}>
          ›
        </span>
        {aberto ? 'ocultar o que está sendo transmitido' : 'ver o que está sendo transmitido'}
      </button>

      {aberto && (
        <div className="relative w-full max-w-xs overflow-hidden rounded-md border border-edge bg-void">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="block aspect-video w-full object-contain"
          />
          {semSinal && (
            <p className="absolute inset-0 flex items-center justify-center gap-1.5 bg-void/90 px-3 text-center text-[12px] text-warn">
              <IconWarning className="h-3.5 w-3.5 shrink-0" />
              A captura não está produzindo imagem. Pare e escolha a tela de novo.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
