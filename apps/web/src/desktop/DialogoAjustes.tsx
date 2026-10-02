import { type RefObject, useId } from 'react';
import type { AjustesDesktop } from './ponte.js';

type Props = {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly aoClicarNoFundo: (evento: React.MouseEvent<HTMLDialogElement>) => void;
  /** `null` enquanto o main não respondeu. */
  readonly ajustes: AjustesDesktop | null;
  readonly bandeja: boolean;
  /** Gravar o autostart falhou na última tentativa. */
  readonly autostartFalhou: boolean;
  readonly aoMudar: (parcial: Partial<AjustesDesktop>) => void;
  readonly fecharRef: RefObject<HTMLButtonElement | null>;
  readonly aoFechar: () => void;
};

type LinhaProps = {
  readonly rotulo: string;
  readonly descricao: string;
  readonly marcado: boolean;
  readonly desabilitado: boolean;
  readonly aoMudar: (valor: boolean) => void;
};

function Linha({ rotulo, descricao, marcado, desabilitado, aoMudar }: LinhaProps) {
  const id = useId();
  const idDescricao = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={marcado}
        disabled={desabilitado}
        aria-describedby={idDescricao}
        onChange={(e) => aoMudar(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-[13px] text-text">
          {rotulo}
        </label>
        <span id={idDescricao} className="text-[12px] leading-snug text-dim [text-wrap:pretty]">
          {descricao}
        </span>
      </div>
    </div>
  );
}

/**
 * AJUSTES do app (D4): três chaves, nada mais. Cada uma grava na hora — não há
 * "salvar" para esquecer. Só desenho: `useAjustes` conversa com o main.
 */
export function DialogoAjustes({
  dialogRef,
  aoClicarNoFundo,
  ajustes,
  bandeja,
  autostartFalhou,
  aoMudar,
  fecharRef,
  aoFechar,
}: Props) {
  const idTitulo = useId();
  const pronto = ajustes !== null;
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={idTitulo}
      onClick={aoClicarNoFundo}
      className="m-auto w-[min(520px,calc(100vw-24px))] border-2 border-edge bg-bar p-0 text-text shadow-[0_0_0_2px_#000,0_30px_80px_rgb(0_0_0_/_0.7)] backdrop:bg-black/75"
    >
      <div className="flex flex-col">
        <div className="titulo-osd !min-h-11">
          <h2 id={idTitulo} className="m-0 font-[inherit] text-[13px] font-bold">
            AJUSTES
          </h2>
        </div>
        <div className="flex flex-col gap-4 px-4 py-5">
          <Linha
            rotulo="Iniciar com o sistema"
            descricao="O Tela abre escondido na bandeja quando você entra no computador. Nunca começa a transmitir sozinho."
            marcado={ajustes?.iniciarComSistema ?? false}
            desabilitado={!pronto}
            aoMudar={(iniciarComSistema) => aoMudar({ iniciarComSistema })}
          />
          {autostartFalhou && (
            <p role="alert" className="m-0 text-[12px] text-danger">
              Não deu para mudar a inicialização com o sistema. Nada foi alterado.
            </p>
          )}
          <Linha
            rotulo="Fechar a janela mantém o Tela em segundo plano"
            descricao={
              bandeja
                ? 'Sem transmissão, fechar a janela a esconde na bandeja em vez de sair. Ao vivo, o Tela pergunta (ou segue a sua escolha lembrada).'
                : 'Este sistema não tem ícone de bandeja, então o Tela sempre sai ao fechar fora do ar. Ao vivo, a janela vira uma faixa compacta.'
            }
            marcado={(ajustes?.fecharEmSegundoPlano ?? false) && bandeja}
            desabilitado={!pronto || !bandeja}
            aoMudar={(fecharEmSegundoPlano) => aoMudar({ fecharEmSegundoPlano })}
          />
          <Linha
            rotulo="Janela compacta sempre no topo"
            descricao="A faixa compacta fica por cima do jogo. Em alguns ambientes Wayland o sistema pode ignorar este pedido."
            marcado={ajustes?.sempreNoTopoNoCompacto ?? false}
            desabilitado={!pronto}
            aoMudar={(sempreNoTopoNoCompacto) => aoMudar({ sempreNoTopoNoCompacto })}
          />
          {ajustes !== null && ajustes.aoFecharAoVivo !== 'perguntar' && (
            <div className="flex flex-wrap items-center gap-3 border-t-2 border-line pt-3 text-[12px] text-dim">
              <span>
                Ao fechar ao vivo, você escolheu{' '}
                {ajustes.aoFecharAoVivo === 'segundo-plano' ? 'continuar em segundo plano' : 'encerrar e sair'}.
              </span>
              <button
                type="button"
                onClick={() => aoMudar({ aoFecharAoVivo: 'perguntar' })}
                className="tecla !min-h-8 px-2 text-[10px]"
              >
                PERGUNTAR DE NOVO
              </button>
            </div>
          )}
        </div>
        <div className="flex justify-end border-t-2 border-line p-3.5">
          <button ref={fecharRef} type="button" onClick={aoFechar} className="tecla tecla-primaria">
            FECHAR
          </button>
        </div>
      </div>
    </dialog>
  );
}
