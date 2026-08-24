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
 *
 * # Por que ele deixou de ser uma miniatura
 *
 * Era 320px de largura, dobrado dentro do HUD que some em cinco segundos.
 * Numa página cujo trabalho inteiro é responder "o que meus amigos estão
 * vendo agora?", a resposta estava na menor caixa da tela e desaparecia
 * sozinha. Agora ele ocupa a coluna principal — e como a coluna principal
 * estava vazia, isso resolve metade do "a tela está vazia" com o conteúdo mais
 * honesto que a página tem: o próprio vídeo.
 *
 * Continua fechável, e fechar continua desmontando o elemento. Quem está com
 * a máquina no limite tira o custo da tela com um clique; o aviso de captura
 * morta sobrevive ao fechamento porque não depende mais deste componente.
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
    <div className="flex flex-col gap-3">
      {/*
        `max-h-[42dvh]` junto com `aspect-video`: a proporção define a altura,
        e o teto impede que ela coma o console inteiro. Sem o teto, a 1366×768
        — o laptop mais comum do público — a prévia sozinha empurrava o
        caminho do vídeo para fora da tela. A caixa deixa de ser 16:9 nessas
        alturas e o `object-contain` letterboxa; é o compromisso certo, porque
        o que não pode faltar é o console, não os últimos pixels da miniatura.
      */}
      {aberto ? (
        <div className="relative mx-auto aspect-video max-h-[42dvh] w-full overflow-hidden rounded-md border border-line bg-void">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="block h-full w-full bg-void object-contain"
          />
          {semSinal && (
            <p className="absolute inset-0 flex items-center justify-center gap-2 bg-void/92 px-6 text-center text-[14px] leading-relaxed text-warn">
              <IconWarning className="h-4 w-4 shrink-0" />
              A captura não está produzindo imagem. Pare e escolha a tela de novo.
            </p>
          )}
        </div>
      ) : (
        /*
          O lugar do vídeo não some junto com ele: sem um vazio da mesma
          altura, fechar a prévia empurrava toda a coluna ao lado para cima e a
          página inteira dava um pulo. Reservar o espaço custa nada e é o que
          mantém `CLS` em zero.
        */
        <div className="mx-auto flex aspect-video max-h-[42dvh] w-full items-center justify-center rounded-md border border-dashed border-line bg-surface px-6 text-center">
          <p className="max-w-[36ch] text-[13px] leading-relaxed text-muted">
            Prévia desligada. A transmissão continua no ar — isto aqui só deixa
            de desenhar o vídeo nesta máquina.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={aberto}
        className="inline-flex min-h-11 items-center gap-2 self-start rounded-sm px-2 text-[13px] text-muted transition-colors duration-150 hover:text-text"
      >
        <span
          className={`inline-block transition-transform duration-150 ${aberto ? 'rotate-90' : ''}`}
        >
          ›
        </span>
        {aberto ? 'ocultar a prévia' : 'mostrar a prévia'}
      </button>
    </div>
  );
}
