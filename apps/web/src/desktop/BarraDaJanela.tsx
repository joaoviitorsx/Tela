import type { ReactNode } from 'react';
import { IconGithub } from '../components/Icon.js';
import { Marca } from '../components/Marca.js';

type Props = {
  /** No Windows os botões são do sistema (overlay); no Linux são nossos. */
  readonly plataforma: 'win32' | 'linux';
  /** O link do canal sem esquema, ao vivo; `null` fora do ar. */
  readonly link: string | null;
  /** Janela com o foco: sem ele a barra esmaece. */
  readonly ativa: boolean;
  readonly maximizada: boolean;
  /** No compacto não há maximizar. */
  readonly compacto: boolean;
  readonly aoMinimizar: () => void;
  readonly aoAlternarMaximizar: () => void;
  readonly aoFechar: () => void;
  /** O código-fonte no navegador do sistema. Sem ação, sem ícone. */
  readonly aoAbrirRepositorio?: (() => void) | undefined;
};

/** `no-drag` nos botões: a região arrastável engole o clique. */
const SEM_ARRASTO = '[-webkit-app-region:no-drag]';

const BASE_BOTAO = [
  'flex h-8 w-9 items-center justify-center text-muted transition-colors',
  'hover:bg-line hover:text-text',
  'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-hi',
  SEM_ARRASTO,
].join(' ');

function Botao({ rotulo, classe, aoClicar, children }: { rotulo: string; classe?: string; aoClicar: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={rotulo} title={rotulo} onClick={aoClicar} className={`${BASE_BOTAO} ${classe ?? ''}`}>
      {children}
    </button>
  );
}

/**
 * A barra de título do app (a ilustração do BAIXAR APP, em `ConteudoApp`):
 * 32 px, ícone, marca, o link ao vivo e, no Linux, os três botões.
 * No Windows o overlay nativo ocupa o canto direito e a barra deixa o espaço
 * — pelas variáveis `env(titlebar-area-*)`, com 138 px de reserva.
 *
 * Burra: não sabe de IPC nem de política de fechar. O botão de fechar só
 * avisa; quem decide (perguntar, esconder, sair) é o main.
 */
export function BarraDaJanela({
  plataforma,
  link,
  ativa,
  maximizada,
  compacto,
  aoMinimizar,
  aoAlternarMaximizar,
  aoFechar,
  aoAbrirRepositorio,
}: Props) {
  const proprios = plataforma === 'linux';
  return (
    <div
      role="group"
      aria-label="Barra da janela"
      data-barra-da-janela={plataforma}
      data-ativa={ativa}
      style={
        proprios
          ? undefined
          : { paddingRight: 'calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100% - 138px)))' }
      }
      className={[
        'flex h-8 shrink-0 select-none items-center gap-2 border-b-2 border-line bg-void pl-2.5',
        '[-webkit-app-region:drag]',
        ativa ? '' : '[&>*]:opacity-60',
      ].join(' ')}
    >
      <img src="/tela-app-icon.png" alt="" width={18} height={18} className="h-[18px] w-[18px] shrink-0" />
      <Marca tamanho="pequeno" />
      {link !== null && <span className="rotulo min-w-0 truncate">{link}</span>}
      <span className="flex-1" />
      {aoAbrirRepositorio !== undefined && (
        <Botao rotulo="Código no GitHub" aoClicar={aoAbrirRepositorio}>
          <IconGithub className="h-3.5 w-3.5" />
        </Botao>
      )}
      {proprios && (
        <div className="flex shrink-0">
          <Botao rotulo="Minimizar" aoClicar={aoMinimizar}>
            <span aria-hidden="true" className="h-0.5 w-2.5 bg-current" />
          </Botao>
          {!compacto && (
            <Botao rotulo={maximizada ? 'Restaurar' : 'Maximizar'} aoClicar={aoAlternarMaximizar}>
              {maximizada ? (
                <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="0.75" y="2.75" width="6.5" height="6.5" />
                  <path d="M2.75 2.75V0.75H9.25V7.25H7.25" />
                </svg>
              ) : (
                <span aria-hidden="true" className="h-2.5 w-2.5 border-[1.5px] border-current" />
              )}
            </Botao>
          )}
          <Botao
            rotulo="Fechar"
            aoClicar={aoFechar}
            classe="!bg-[#2a0f0b] !text-danger hover:!bg-danger-bg hover:!text-danger-ink text-[12px]"
          >
            <span aria-hidden="true">×</span>
          </Botao>
        </div>
      )}
    </div>
  );
}
