import type { ReactNode } from 'react';
import { Led } from './Led.js';
import { Marca } from './Marca.js';

type Props = {
  /** O menu de prévia, montado por quem tem o estado. */
  readonly menu: ReactNode;
  readonly posicao: string;
};

/**
 * "BAIXAR ▸ APP DESKTOP", do protótipo — com o app ainda por fazer.
 *
 * Os downloads ficam visíveis e DESLIGADOS com "em breve": um link para um
 * instalador que não existe seria pior que nenhum botão. O resto é prévia do
 * que o app vai fazer, escrito como plano.
 */
export function ConteudoApp({ menu, posicao }: Props) {
  return (
    <div className="grid items-start gap-6 p-4 sm:p-5 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-4">
            <img src="/tela-app-icon.svg" alt="" width={64} height={64} className="h-16 w-16" />
            <p className="numeral m-0 text-[44px] leading-none text-accent-hi">
              Tela para desktop
            </p>
          </div>
          <p className="m-0 text-[12px] leading-relaxed text-muted [text-wrap:pretty]">
            Captura mais confiável, só o áudio do jogo e a transmissão em segundo plano. Mesmo link,
            mesma sala. <strong className="text-warn">Ainda não foi lançado</strong> — isto é o que
            vem.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {['WINDOWS · .EXE', 'LINUX · .APPIMAGE'].map((rotulo) => (
            <button
              key={rotulo}
              type="button"
              disabled
              aria-disabled="true"
              className="tecla flex min-h-13 cursor-not-allowed flex-col items-center justify-center gap-0.5 opacity-70"
            >
              <span>{rotulo}</span>
              <span className="text-[10px] text-dim">EM BREVE</span>
            </button>
          ))}
        </div>
        <div className="flex flex-col border-2 border-edge bg-surface">
          <div className="flex items-center border-b-2 border-line px-3.5 py-2">
            <span className="rotulo !text-accent">O QUE MUDA NO APP</span>
            <span className="flex-1" />
            <span className="rotulo">{posicao}</span>
          </div>
          {menu}
        </div>
      </div>

      <div className="flex flex-col gap-3.5">
        <span className="rotulo">SEGUNDO PLANO · JANELA COMPACTA</span>
        <div className="flex w-full max-w-[380px] flex-col border-2 border-edge bg-surface shadow-[0_0_0_2px_#000,0_24px_60px_rgb(0_0_0_/_0.6)]">
          <div className="flex h-8 items-center gap-2 border-b-2 border-line bg-void pl-2.5">
            <img src="/tela-app-icon.svg" alt="" width={18} height={18} className="h-[18px] w-[18px]" />
            <Marca tamanho="pequeno" />
            <span className="rotulo">tela.gg/seucanal</span>
            <span className="flex-1" />
            <span aria-hidden="true" className="flex h-8 w-9 items-center justify-center">
              <span className="h-0.5 w-2.5 bg-muted" />
            </span>
            <span aria-hidden="true" className="flex h-8 w-9 items-center justify-center bg-[#2a0f0b] text-[12px] text-danger">
              ×
            </span>
          </div>
          <div className="flex items-center gap-3 p-3.5">
            <span className="flex items-center gap-1.5 bg-live px-2 py-1 font-[family-name:var(--font-pixel)] text-[11px] text-white">
              <Led pisca />
              NO AR
            </span>
            <span className="numeral text-[26px] leading-none">00:00:00</span>
            <span className="flex-1" />
            <span className="numeral text-[24px] text-accent-hi">0/5</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 border-t-2 border-line p-2.5">
            <span className="tecla pointer-events-none min-h-9 text-[11px]">COPIAR LINK</span>
            <span className="tecla pointer-events-none min-h-9 text-[11px] text-danger">ENCERRAR</span>
          </div>
        </div>
        <p className="m-0 max-w-[380px] text-[11px] leading-relaxed text-dim [text-wrap:pretty]">
          Planejado: fechar a janela não derruba a transmissão — o Tela vai para a bandeja do sistema
          e continua no ar enquanto você joga.
        </p>
      </div>
    </div>
  );
}
