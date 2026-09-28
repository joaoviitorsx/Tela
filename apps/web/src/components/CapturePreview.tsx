import { useEffect, useRef } from 'react';

type Props = {
  readonly stream: MediaStream | null;
  readonly aberto: boolean;
  readonly onToggle: () => void;
  readonly semSinal: boolean;
  /** "00:12:34": o tempo no ar, calculado pela rota. */
  readonly tempoNoAr: string;
  /** Pausa de privacidade em curso: a prévia diz o que os amigos veem. */
  readonly oculto?: boolean;
};

/**
 * O que seus amigos estão vendo: o próprio stream capturado, sem áudio.
 *
 * # Custo
 *
 * `aberto` liga e desliga o DECODE local. Opacidade zero NÃO para o vídeo:
 * medido, 30 quadros por segundo continuavam sendo entregues a um elemento
 * invisível, na máquina que está rodando o jogo. Fechada, a caixa mantém o
 * mesmo tamanho para o painel ao lado não dar um pulo (CLS zero).
 *
 * `max-h-[42dvh]` com `aspect-video`: a 1366×768 a prévia sozinha empurrava o
 * console para fora da tela. A caixa deixa de ser 16:9 e o `object-contain`
 * letterboxa; o que não pode faltar é o painel, não os últimos pixels.
 *
 * A imagem fica acima das scanlines (`acima-do-crt`): a prévia é o jogo, e o
 * jogo nunca leva listras.
 */
export function CapturePreview({ stream, aberto, onToggle, semSinal, tempoNoAr, oculto = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (element === null || stream === null || !aberto) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    void element.play().catch(() => undefined);
  }, [stream, aberto]);

  return (
    <div className="acima-do-crt relative h-full min-h-[240px] w-full min-w-0 overflow-hidden border-2 border-line bg-black">
        {aberto ? (
          <video ref={videoRef} autoPlay playsInline muted className="block h-full w-full bg-black object-contain" />
        ) : (
          <p className="absolute inset-0 m-0 flex items-center justify-center px-6 text-center text-[12px] leading-relaxed text-muted">
            Prévia desligada. A transmissão continua no ar: só deixa de desenhar o vídeo nesta máquina.
          </p>
        )}

        <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-1.5">
          <span className="flex items-center gap-2 border-2 border-b-[#5a120c] border-l-[#ff8a76] border-r-[#5a120c] border-t-[#ff8a76] bg-live px-2.5 py-1">
            <span aria-hidden="true" className="led-pisca h-2 w-2 bg-white" />
            <span className="font-[family-name:var(--font-pixel)] text-[12px] font-bold text-white">NO AR</span>
            <span className="numeral text-[20px] text-white">{tempoNoAr}</span>
          </span>
          <span className="bg-black/70 px-2 py-0.5 font-[family-name:var(--font-pixel)] text-[11px] text-text">
            {oculto ? 'OCULTA · SEUS AMIGOS VEEM "TRANSMISSÃO PAUSADA"' : 'O QUE SEUS AMIGOS ESTÃO VENDO'}
          </span>
        </div>

        {aberto && semSinal && (
          <p
            role="status"
            className="absolute inset-0 m-0 flex items-center justify-center gap-2 bg-black/90 px-6 text-center text-[12px] leading-relaxed text-warn"
          >
            <span aria-hidden="true" className="font-[family-name:var(--font-pixel)] text-accent">!</span>
            A captura não está produzindo imagem. Pare e escolha a tela de novo.
          </p>
        )}
      {/* Desligar a prévia poupa a máquina do jogo; a transmissão segue. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={aberto}
        className="tecla absolute bottom-3 right-3 bg-black/70"
      >
        {aberto ? 'DESLIGAR PRÉVIA' : 'LIGAR PRÉVIA'}
      </button>
    </div>
  );
}
