import { useEffect, useState } from 'react';
import { IconCheck, IconCopy, IconStop, IconViewers, IconWarning } from './Icon.js';
import { LiveDot } from './LiveDot.js';

type Props = {
  readonly shareUrl: string;
  readonly viewers: number;
  /** Teto do canal. Mostrar `2/5` diz mais que `2` — o usuário sabe quanto falta. */
  readonly maxPeers: number;
  /** Canal de sinalização caiu: quem assiste continua, ninguém novo entra. */
  readonly semSinalizacao: boolean;
  /** A captura parou de entregar imagem ao encoder. Medido pela sessão. */
  readonly semSinal: boolean;
  /** Escolheu janela em vez de tela inteira, e o áudio do sistema ficou de fora. */
  readonly audioPerdidoPelaEscolha: boolean;
  readonly presetForced: boolean;
  /** Por que caiu: `cpu` (encode pesado) ou `bandwidth` (link). */
  readonly motivoDegradacao: 'cpu' | 'bandwidth' | 'none' | 'other' | null;
  /** Diagnóstico do momento vindo do WebRTC. `null` quando está tudo bem. */
  readonly aviso: string | null;
  readonly onSwitchSource: () => void;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onStop: () => void;
  readonly visible: boolean;
  /** Ponteiro em cima ou foco dentro: o HUD não pode sumir enquanto se usa. */
  readonly onInteracao: (ativo: boolean) => void;
  readonly reconnecting: boolean;
};

/**
 * A barra de identificação da transmissão: quem sou eu, quem está vendo, o que
 * está errado, e o botão de parar.
 *
 * # O que saiu daqui, e por quê
 *
 * Ela tinha virado a página inteira: prévia, escolha de qualidade, prioridade
 * de rede, volume, estatísticas e quatro avisos, tudo dentro de um painel que
 * chegava a 387px de altura — e que some sozinho depois de cinco segundos.
 * Enquanto isso o corpo da página tinha duas linhas de texto cinza e mais
 * nada. Tudo que importava estava amontoado no lugar que desaparece, e o lugar
 * que fica estava vazio.
 *
 * A divisão agora é por natureza, não por sobra de espaço:
 *
 * - **aqui** ficam identidade, contagem, alertas e as duas ações que mexem na
 *   transmissão inteira (trocar tela, parar);
 * - **no console da página** ficam leituras e controles, que a pessoa procura
 *   quando quer mexer, não quando passa o olho.
 *
 * Continua sumindo em 5s e voltando no mousemove, porque quem captura a tela
 * inteira está mandando esta página para os amigos junto com o jogo.
 *
 * # De `fixed` para `sticky`
 *
 * Era `fixed top-0`, e por isso cobria o conteúdo abaixo — o remendo anterior
 * foi empurrar o texto da página para `pb-[14vh]`, que resolvia em 1366×768 e
 * voltava a quebrar em qualquer outra altura ou com um aviso a mais aberto. Em
 * fluxo com `sticky` o painel OCUPA a altura dele: não há o que cobrir, em
 * nenhuma tela, com nenhum aviso aberto. O `opacity` continua fazendo o
 * desaparecimento, então nada salta de lugar quando ele volta.
 */
export function LiveHud({
  shareUrl,
  viewers,
  maxPeers,
  semSinalizacao,
  semSinal,
  audioPerdidoPelaEscolha,
  presetForced,
  motivoDegradacao,
  aviso,
  onSwitchSource,
  copied,
  onCopy,
  onStop,
  visible,
  onInteracao,
  reconnecting,
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

  /*
    Todos os alertas num lugar só, na ordem em que doem: sem imagem (ninguém
    está vendo nada), sem servidor (ninguém novo entra), sem áudio, qualidade
    reduzida, e o diagnóstico do momento. Antes estavam espalhados em quatro
    pontos do painel, e o quinto — o `qualityLimitationReason` — vivia dentro
    da tira de números, onde só aparecia para quem já sabia que ele existia.

    O motivo da degradação muda o que a pessoa faz. `cpu` quase sempre é
    encode em SOFTWARE, o caso que rouba quadros do jogo e que tem conserto do
    lado de quem transmite; `bandwidth` é o link, e não adianta mexer na
    máquina. Dizer "o encoder não estava dando conta" nos dois casos mandava
    metade das pessoas caçar o problema no lugar errado.
  */
  const alertas: readonly { chave: string; texto: string }[] = [
    semSinal && {
      chave: 'sem-sinal',
      texto:
        'A captura não está produzindo imagem — os amigos estão vendo preto. Pare e escolha a tela de novo.',
    },
    semSinalizacao && {
      chave: 'sem-sinalizacao',
      texto:
        'Servidor fora do ar. Quem já está assistindo continua vendo — mas ninguém novo consegue entrar pelo link.',
    },
    audioPerdidoPelaEscolha && {
      chave: 'sem-audio',
      texto:
        'Sem áudio: o som do sistema só acompanha a tela inteira. Pare e escolha "Tela inteira" no seletor.',
    },
    presetForced && {
      chave: 'degradado',
      texto:
        motivoDegradacao === 'cpu'
          ? 'Qualidade reduzida — o encode está pesando na máquina. Confira se a aceleração por hardware está ligada em chrome://gpu; em software, o jogo perde quadros.'
          : motivoDegradacao === 'bandwidth'
            ? 'Qualidade reduzida — sua subida não comporta o que estava configurado. Volta sozinho quando a rede sobrar.'
            : 'Qualidade reduzida automaticamente.',
    },
    aviso !== null && { chave: 'aviso', texto: aviso },
  ].filter((item): item is { chave: string; texto: string } => item !== false);

  return (
    <div
      onPointerEnter={() => setComPonteiro(true)}
      onPointerLeave={() => setComPonteiro(false)}
      onFocusCapture={() => setComFoco(true)}
      onBlurCapture={() => setComFoco(false)}
      className={[
        'pointer-events-none sticky top-0 z-20 px-3 pt-3 sm:px-5 sm:pt-4',
        'transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
    >
      <div className="pointer-events-auto mx-auto flex max-w-[1180px] flex-col gap-2 rounded-md border border-edge bg-surface/95 p-2.5 backdrop-blur-sm sm:p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {reconnecting ? <LiveDot label="RECONECTANDO" tone="warn" /> : <LiveDot />}

          <button
            type="button"
            onClick={onCopy}
            className="tabular group inline-flex min-h-11 min-w-0 items-center gap-2 rounded-sm px-2 text-[14px] text-text transition-colors duration-150 hover:bg-void sm:text-[15px]"
          >
            <span className="truncate">{shareUrl.replace(/^https?:\/\//, '')}</span>
            {copied ? (
              <IconCheck className="h-4 w-4 shrink-0 text-text" />
            ) : (
              <IconCopy className="h-4 w-4 shrink-0 text-muted group-hover:text-text" />
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

          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onSwitchSource}
              title="Escolher outra tela ou janela sem derrubar quem está assistindo"
              className="inline-flex min-h-11 items-center rounded-sm border border-edge px-3 text-[13px] text-muted transition-colors duration-150 hover:border-text hover:text-text"
            >
              trocar tela
            </button>
            <button
              type="button"
              onClick={onStop}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-sm border border-edge px-3 text-[13px] text-muted transition-colors duration-150 hover:border-danger hover:text-danger"
            >
              <IconStop className="h-3 w-3" />
              parar
            </button>
          </span>
        </div>

        {alertas.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-line pt-2">
            {alertas.map((alerta) => (
              <p
                key={alerta.chave}
                role="status"
                className="flex items-start gap-1.5 text-[12px] leading-snug text-warn"
              >
                <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {alerta.texto}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
