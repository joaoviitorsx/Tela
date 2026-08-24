import { type CSSProperties, useEffect, useState } from 'react';
import { IconMuted, IconVolumeHigh, IconVolumeLow } from './Icon.js';

type Props = {
  readonly volume: number;
  readonly mudo: boolean;
  readonly ajustavel: boolean;
  readonly ativo: boolean;
  readonly onVolume: (valor: number) => void;
  readonly onAlternar: () => void;
  /** Passo das setas. O mesmo do atalho global, senão a tecla anda dois valores. */
  readonly passo: number;
  /** Avisa o HUD para não sumir enquanto a pessoa mira, arrasta ou tabula. */
  readonly onAtivo: (ativo: boolean) => void;
};

/**
 * Volume do espectador, na língua do HUD.
 *
 * O painel deste produto é instrumento, não player: números em monoespaçada
 * tabular, trilho de um fio, zero moldura. Este controle segue a mesma regra
 * em vez de importar o visual de um player de vídeo genérico — o `%` aqui é
 * irmão do `18 ms` que fica ao lado, não de um tooltip do YouTube.
 *
 * Três decisões que parecem detalhe e não são:
 *
 * 1. A leitura em `%` ocupa largura FIXA e só aparece durante o uso. Fixa
 *    porque o HUD não pode reflowar quando o número entra — é a mesma razão
 *    do `.tabular` existir. Só durante o uso porque em repouso o preenchimento
 *    da barra já diz o nível, e um número a mais competiria com a latência.
 *
 * 2. Mudo NÃO zera a barra. Quem silenciou precisa ver para onde o som volta;
 *    o apagamento do trilho (`data-mudo`) é que comunica o silêncio.
 *
 * 3. Onde `video.volume` é ignorado — iOS — a barra não é renderizada e resta
 *    o botão de mudo, que lá funciona. Um controle que o usuário arrasta sem
 *    efeito nenhum é pior do que controle nenhum.
 *
 * Nada de verde: o acento é do AO VIVO. Volume não é estado de transmissão.
 */
export function VolumeControl({
  volume,
  mudo,
  ajustavel,
  ativo,
  onVolume,
  onAlternar,
  passo,
  onAtivo,
}: Props) {
  const Icone = mudo ? IconMuted : volume < 0.5 ? IconVolumeLow : IconVolumeHigh;
  const porcento = Math.round(volume * 100);

  /**
   * Ponteiro e foco são condições INDEPENDENTES, e precisam de um estado cada.
   *
   * Com um booleano só, os quatro handlers escreviam no mesmo lugar e o último
   * evento apagava o outro: tabular para fora com o mouse parado sobre a barra
   * mandava `false` e o HUD sumia debaixo do ponteiro; entrar e sair com o
   * mouse enquanto o teclado tinha o foco fazia o mesmo. Some quando NENHUM
   * dos dois está presente — nunca quando um deles sai.
   */
  const [comPonteiro, setComPonteiro] = useState(false);
  const [comFoco, setComFoco] = useState(false);

  useEffect(() => {
    onAtivo(comPonteiro || comFoco);
  }, [comPonteiro, comFoco, onAtivo]);

  return (
    <div
      className="pointer-events-auto flex items-center gap-2 [touch-action:manipulation]"
      onFocusCapture={() => setComFoco(true)}
      onBlurCapture={() => setComFoco(false)}
      onPointerEnter={() => setComPonteiro(true)}
      onPointerLeave={() => setComPonteiro(false)}
    >
      {/*
        44px de alvo, não 36: este HUD é usado no celular, e ali o dedo não
        acerta o que o mouse acerta. O ícone continua com 18px.
      */}
      <button
        type="button"
        onClick={onAlternar}
        aria-label={mudo ? 'Ativar o som' : 'Silenciar'}
        aria-pressed={mudo}
        className="inline-flex h-11 w-11 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface hover:text-text"
      >
        <Icone className="h-[18px] w-[18px] shrink-0" />
      </button>

      {ajustavel && (
        <>
          <input
            type="range"
            min={0}
            max={1}
            step={passo}
            value={volume}
            onChange={(event) => onVolume(event.currentTarget.valueAsNumber)}
            data-mudo={mudo}
            style={{ '--preenchido': `${porcento}%` } as CSSProperties}
            aria-label="Volume da transmissão"
            aria-valuetext={mudo ? 'mudo' : `${porcento} por cento`}
            className="faixa-volume w-24"
          />

          {/*
            `aria-hidden`: o valor já vai ao leitor de tela pelo `aria-valuetext`
            do range. Repetir aqui faria o leitor anunciar o volume duas vezes a
            cada passo da seta.
          */}
          <span
            aria-hidden="true"
            className={`tabular w-9 text-right text-[12px] tabular-nums transition-opacity duration-150 ${
              ativo ? 'text-muted opacity-100' : 'opacity-0'
            }`}
          >
            {mudo ? '—' : `${porcento}%`}
          </span>
        </>
      )}
    </div>
  );
}
