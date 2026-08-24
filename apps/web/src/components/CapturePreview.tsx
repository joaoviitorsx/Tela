import { useEffect, useRef, useState } from 'react';
import { IconWarning } from './Icon.js';

type Props = {
  readonly stream: MediaStream | null;
  readonly aberto: boolean;
  readonly onToggle: () => void;
  /** Sobe o diagnóstico para quem consegue mostrá-lo com o preview fechado. */
  readonly onSemSinal: (semSinal: boolean) => void;
};

/**
 * Cinco segundos sem um único frame é evidência suficiente para acusar.
 * Também é o tempo que uma captura demora a engatar em máquina lenta.
 */
const LIMITE_SEM_FRAME_MS = 5_000;

/**
 * O que está sendo capturado, do lado de quem transmite.
 *
 * Serve como confirmação — ninguém deveria transmitir às cegas — e como
 * DIAGNÓSTICO. Sem ele, "está preto" tem duas causas indistinguíveis: a
 * captura não produziu frame nenhum, ou produziu e a rede não entregou. Com
 * ele a pergunta se responde olhando.
 *
 * Mudo, sempre. Tocar o áudio do jogo de volta nos alto-falantes de quem está
 * jogando cria eco, e o navegador ainda pode capturar esse eco de volta.
 *
 * Ao capturar a tela inteira o preview mostra a si mesmo, em recursão. É
 * inevitável e é o mesmo comportamento do OBS — e, na prática, é o sinal
 * visual mais rápido de que a captura de tela inteira está funcionando.
 *
 * # Por que o vídeo continua montado com o preview fechado
 *
 * A detecção de captura morta vivia dentro do bloco visível, então fechar o
 * preview apagava o AVISO junto com a imagem — e o produto convida a fechar
 * ("O usuário fecha se atrapalhar"). O resultado era a pior tela possível:
 * "transmitindo, seu jogo está indo para tela.gg/x" enquanto os amigos viam
 * preto, sem nada explicando.
 *
 * Fechado, o elemento vira 1×1 invisível em vez de desmontar. `opacity-0`
 * e não `display:none`: o segundo faz o navegador parar de puxar frames, e aí
 * não há o que detectar.
 */
export function CapturePreview({ stream, aberto, onToggle, onSemSinal }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [semSinal, setSemSinal] = useState(false);

  // Ref e não dependência: o pai passa uma função nova a cada render, e
  // colocá-la nas deps reiniciaria o relógio de detecção sem parar.
  const avisar = useRef(onSemSinal);
  avisar.current = onSemSinal;

  useEffect(() => {
    const element = videoRef.current;
    if (element === null || stream === null) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    void element.play().catch(() => undefined);
  }, [stream]);

  /**
   * Captura que não entrega frame.
   *
   * Acontece de verdade: em alguns caminhos de captura de tela inteira —
   * Wayland via portal, por exemplo — a trilha é criada e nunca produz
   * imagem. O navegador não avisa; a transmissão sai preta e ninguém sabe por
   * quê.
   *
   * É verificação PERIÓDICA, não um relógio de uma vez só. A versão anterior
   * disparava uma vez, cinco segundos depois de abrir, e nunca mais: captura
   * que morria no meio da partida — a tela que trava, a janela que fecha —
   * passava despercebida para sempre.
   */
  useEffect(() => {
    if (stream === null) {
      setSemSinal(false);
      avisar.current(false);
      return;
    }

    let ultimoFrame = Date.now();
    let tempoAnterior = -1;

    const relogio = window.setInterval(() => {
      const element = videoRef.current;
      if (element === null) return;

      // `currentTime` que anda é a prova de que frame novo chegou; só
      // `videoWidth` não distingue "engatou e parou" de "está rodando".
      const avancou = element.currentTime !== tempoAnterior;
      tempoAnterior = element.currentTime;
      if (element.videoWidth > 0 && avancou) ultimoFrame = Date.now();

      const morto = Date.now() - ultimoFrame >= LIMITE_SEM_FRAME_MS;
      setSemSinal(morto);
      avisar.current(morto);
    }, 1_000);

    return () => {
      window.clearInterval(relogio);
      avisar.current(false);
    };
  }, [stream]);

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

      <div
        className={
          aberto
            ? 'relative w-full max-w-xs overflow-hidden rounded-md border border-edge bg-void'
            : 'pointer-events-none fixed left-0 top-0 h-px w-px overflow-hidden opacity-0'
        }
        aria-hidden={!aberto}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={aberto ? 'block aspect-video w-full object-contain' : 'block h-px w-px'}
        />
        {aberto && semSinal && (
          <p className="absolute inset-0 flex items-center justify-center gap-1.5 bg-void/90 px-3 text-center text-[12px] text-warn">
            <IconWarning className="h-3.5 w-3.5 shrink-0" />
            A captura não está produzindo imagem. Pare e escolha a tela de novo.
          </p>
        )}
      </div>
    </div>
  );
}
