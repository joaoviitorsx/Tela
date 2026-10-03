import { type RefObject, useId } from 'react';
import { linhaDeAtualizacao, ultimaVerificacao } from './atualizacao.js';
import type { AjustesDesktop, CantoDoPainel, EstadoDaAtualizacao } from './ponte.js';

const CANTOS: readonly { readonly valor: CantoDoPainel; readonly rotulo: string }[] = [
  { valor: 'sup-esq', rotulo: '↖ CIMA' },
  { valor: 'sup-dir', rotulo: 'CIMA ↗' },
  { valor: 'inf-esq', rotulo: '↙ BAIXO' },
  { valor: 'inf-dir', rotulo: 'BAIXO ↘' },
];

/** A parte "atualização" do painel (D5). Sem ela (dev no navegador) a seção some. */
export type PropsDeAtualizacao = {
  readonly versao: string;
  /** `null` até o main responder. */
  readonly estado: EstadoDaAtualizacao | null;
  readonly aoVerificar: () => void;
  readonly aoReiniciar: () => void;
  /** deb/rpm: abre a página do pacote (o main só abre `https:`). */
  readonly aoAbrirPagina: (url: string) => void;
};

type Props = {
  readonly atualizacao?: PropsDeAtualizacao;
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

const TOM: Record<'neutro' | 'pronta' | 'erro', string> = {
  neutro: 'text-dim',
  pronta: 'text-accent',
  erro: 'text-danger',
};

/** Versão, estado e as ações da atualização. Só desenho: o estado vem do main. */
function SecaoDeAtualizacao({ versao, estado, aoVerificar, aoReiniciar, aoAbrirPagina }: PropsDeAtualizacao) {
  const linha = estado === null ? null : linhaDeAtualizacao(estado);
  return (
    <div className="flex flex-col gap-2 border-t-2 border-line pt-3 text-[12px]">
      <div className="text-text">Versão {versao}</div>
      {linha !== null && estado !== null && (
        <>
          <p role="status" className={`m-0 leading-snug [text-wrap:pretty] ${TOM[linha.tom]}`}>
            {linha.texto}
          </p>
          {estado.fase === 'baixando' && estado.progresso !== null && (
            <progress
              max={100}
              value={estado.progresso}
              aria-label="Progresso do download"
              className="h-2 w-full accent-accent"
            />
          )}
          {estado.modo !== 'desligada' && (
            <div className="text-dim">Última verificação: {ultimaVerificacao(estado.ultimaVerificacaoMs, Date.now())}</div>
          )}
          <div className="flex flex-wrap gap-2">
            {estado.modo !== 'desligada' && (
              <button
                type="button"
                onClick={aoVerificar}
                disabled={!estado.podeVerificar}
                className="tecla !min-h-8 px-2 text-[10px]"
              >
                VERIFICAR AGORA
              </button>
            )}
            {estado.podeReiniciar && (
              <button type="button" onClick={aoReiniciar} className="tecla tecla-primaria !min-h-8 px-2 text-[10px]">
                REINICIAR E ATUALIZAR
              </button>
            )}
            {estado.pagina !== null && (
              <button
                type="button"
                onClick={() => aoAbrirPagina(estado.pagina ?? '')}
                className="tecla tecla-primaria !min-h-8 px-2 text-[10px]"
              >
                ABRIR PÁGINA
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * AJUSTES do app (D4): quatro chaves e a linha da atualização (D5). Cada uma grava na hora — não há
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
  atualizacao,
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
          <Linha
            rotulo="Painel sobre o jogo"
            descricao="Ao vivo, uma faixa pequena por cima do jogo diz o tempo no ar e quantos assistem — sem Alt+Tab. Não recebe clique nem teclado. No Windows e no macOS ela não aparece na própria transmissão; no Linux, aparece se você capturar a tela inteira. Jogo em tela cheia exclusiva não deixa nada por cima: use tela cheia sem bordas."
            marcado={ajustes?.painelSobreOJogo ?? false}
            desabilitado={!pronto}
            aoMudar={(painelSobreOJogo) => aoMudar({ painelSobreOJogo })}
          />
          {ajustes?.painelSobreOJogo === true && (
            <div className="ml-7 flex flex-wrap items-center gap-2" role="group" aria-label="Canto do painel">
              {CANTOS.map(({ valor, rotulo }) => (
                <button
                  key={valor}
                  type="button"
                  aria-pressed={ajustes.cantoDoPainel === valor}
                  disabled={!pronto}
                  onClick={() => aoMudar({ cantoDoPainel: valor })}
                  className={ajustes.cantoDoPainel === valor ? 'tecla tecla-primaria' : 'tecla'}
                >
                  {rotulo}
                </button>
              ))}
            </div>
          )}
          <Linha
            rotulo="Taxa constante no encoder (experimental)"
            descricao="No Windows, o encoder da GPU pode mandar rajadas de até 10 vezes a taxa pedida, que viram perda e travadinha em rede apertada. Com isto ligado ele segura a taxa constante. Vale na próxima configuração do encoder. Se a imagem piorar, desligue — e conte o que viu."
            marcado={ajustes?.taxaConstante ?? false}
            desabilitado={!pronto}
            aoMudar={(taxaConstante) => aoMudar({ taxaConstante })}
          />
          <Linha
            rotulo="Economizar banda com a tela parada (experimental, Linux)"
            descricao="O encoder da GPU (NVENC) deixa de encher a banda quando a imagem quase não muda — menu, loading, mapa parado: de ~12 para ~1,4 Mbps por espectador, com a mesma imagem. Quando o jogo volta a mexer, a qualidade volta. Se notar a imagem demorando a voltar depois de um menu, desligue e conte."
            marcado={ajustes?.economiaParada ?? false}
            desabilitado={!pronto}
            aoMudar={(economiaParada) => aoMudar({ economiaParada })}
          />
          <Linha
            rotulo="Atualizar automaticamente"
            descricao="Verifica a cada 6 horas e baixa em segundo plano, só com a transmissão fora do ar. A versão nova instala quando você sair do Tela. Nunca mexe numa transmissão no ar."
            marcado={ajustes?.atualizarAutomaticamente ?? true}
            desabilitado={!pronto}
            aoMudar={(atualizarAutomaticamente) => aoMudar({ atualizarAutomaticamente })}
          />
          {atualizacao !== undefined && <SecaoDeAtualizacao {...atualizacao} />}
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
