import { useEffect, useState } from 'react';
import { IconMudo, IconSom } from './Icon.js';

type Props = {
  /** 0 a 1. */
  readonly volume: number;
  readonly mudo: boolean;
  /** `false` onde `video.volume` é ignorado (iOS): fica só o botão de mudo. */
  readonly ajustavel: boolean;
  readonly onVolume: (valor: number) => void;
  readonly onAlternar: () => void;
  /** Passo das setas. O mesmo do atalho global, senão a tecla anda dois valores. */
  readonly passo: number;
  /** Avisa a barra para não sumir enquanto a pessoa mira, arrasta ou tabula. */
  readonly onAtivo: (ativo: boolean) => void;
};

/**
 * O volume do espectador em dez blocos, do jeito do protótipo — e um
 * `<input type="range">` de verdade por cima.
 *
 * Os blocos são só o desenho. Quem responde a teclado, arrasto, toque e leitor
 * de tela é o range invisível esticado sobre eles: setas, `Home`/`End` e
 * `aria-valuetext` vêm do navegador, e o clique num bloco cai no valor certo
 * sem um `onClick` por bloco. Reimplementar um slider com `div` é como se
 * perde o teclado.
 *
 * Mudo NÃO zera os blocos: quem silenciou precisa ver para onde o som volta.
 * Eles só apagam (`opacity`), e o botão diz "mudo".
 *
 * O botão de mudo e o range ficam ambos com 44px de altura.
 */
export function VolumeBlocos({ volume, mudo, ajustavel, onVolume, onAlternar, passo, onAtivo }: Props) {
  const [arrastando, setArrastando] = useState(false);
  const [comFoco, setComFoco] = useState(false);
  const porcento = Math.round(volume * 100);
  const cheios = Math.round(volume * 10);

  useEffect(() => {
    onAtivo(arrastando || comFoco);
  }, [arrastando, comFoco, onAtivo]);

  return (
    <div
      className="pointer-events-auto flex items-center gap-1.5 [touch-action:manipulation]"
      onFocusCapture={(e) => {
        const alvo = e.target as HTMLElement;
        setComFoco(typeof alvo.matches === 'function' && alvo.matches(':focus-visible'));
      }}
      onBlurCapture={() => setComFoco(false)}
      onPointerDown={() => setArrastando(true)}
      onPointerUp={() => setArrastando(false)}
      onPointerCancel={() => setArrastando(false)}
    >
      <button
        type="button"
        onClick={onAlternar}
        aria-label="Silenciar"
        aria-pressed={mudo}
        className="flex h-11 w-11 items-center justify-center border-0 bg-transparent p-0 text-text hover:bg-key hover:text-accent-hi"
      >
        {mudo ? <IconMudo className="h-[18px] w-[18px]" /> : <IconSom className="h-[18px] w-[18px]" />}
      </button>

      {ajustavel && (
        <>
          <div className="relative flex h-11 w-[104px] items-center gap-[3px] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-hi">
            <div aria-hidden="true" className="flex h-4 flex-1 items-stretch gap-[3px]">
              {Array.from({ length: 10 }, (_, j) => (
                <span
                  key={j}
                  className={[
                    'w-2 flex-1',
                    mudo ? 'bg-faint' : 'bg-accent',
                    j < cheios ? 'opacity-100' : 'opacity-20',
                  ].join(' ')}
                />
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={passo}
              value={volume}
              onChange={(e) => onVolume(e.currentTarget.valueAsNumber)}
              aria-label="Volume da transmissão"
              aria-valuetext={mudo ? 'mudo' : `${porcento} por cento`}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </div>
          <span aria-hidden="true" className="numeral w-9 text-right text-[20px] text-muted">
            {mudo ? '—' : porcento}
          </span>
        </>
      )}
    </div>
  );
}
