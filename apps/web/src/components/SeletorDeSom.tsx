import { type KeyboardEvent, useId } from 'react';
import { Botao } from './Botao.js';

export type OpcaoDeSom = 'sistema' | 'jogo' | 'nenhum';

export type AppNaLista = {
  readonly id: string;
  readonly nome: string;
  readonly tocando: boolean;
  readonly icone: string | null;
};

type Props = {
  readonly opcao: OpcaoDeSom;
  /** `null` enquanto o app ainda pergunta ao sistema se "só o jogo" existe. */
  readonly jogoDisponivel: boolean | null;
  /** Por que "só o jogo" está desabilitado. Aparece NA opção, não num tooltip. */
  readonly motivoDoJogo: string | null;
  readonly apps: readonly AppNaLista[];
  readonly appEscolhido: string | null;
  readonly listando: boolean;
  /** O modo REAL por extenso, e se ele difere do que a pessoa escolheu. */
  readonly real: { readonly rotulo: string; readonly tom: 'ok' | 'alerta' };
  /** O Windows só leva o som do sistema junto da tela inteira. */
  readonly avisoDoSistema: string | null;
  readonly aoEscolherOpcao: (opcao: OpcaoDeSom) => void;
  readonly aoEscolherApp: (id: string) => void;
  readonly aoAtualizar: () => void;
};

const OPCOES: ReadonlyArray<{ readonly id: OpcaoDeSom; readonly nome: string; readonly texto: string }> = [
  { id: 'sistema', nome: 'SISTEMA', texto: 'Tudo que toca no seu PC, inclusive a call de voz.' },
  { id: 'jogo', nome: 'SÓ O JOGO', texto: 'O som de um programa só. A call fica de fora.' },
  { id: 'nenhum', nome: 'SEM SOM', texto: 'Só a imagem, sem áudio.' },
];

/** ←/→/↑/↓ movem a seleção entre os rádios habilitados, como num `radiogroup` nativo. */
function teclasDoGrupo(evento: KeyboardEvent<HTMLElement>, ids: readonly string[], atual: string | null, escolher: (id: string) => void) {
  const mais = evento.key === 'ArrowRight' || evento.key === 'ArrowDown';
  const menos = evento.key === 'ArrowLeft' || evento.key === 'ArrowUp';
  if (!mais && !menos) return;
  evento.preventDefault();
  if (ids.length === 0) return;
  const i = atual === null ? -1 : ids.indexOf(atual);
  const proximo = ids[(i + (mais ? 1 : ids.length - 1) + ids.length) % ids.length];
  if (proximo === undefined) return;
  escolher(proximo);
  (evento.currentTarget.querySelector(`[data-id="${CSS.escape(proximo)}"]`) as HTMLElement | null)?.focus();
}

/**
 * O passo ÁUDIO do app (D3, PLANO-desktop §4): três opções e o modo REAL.
 *
 * O protótipo da web tinha "som do sistema" e "sem áudio" como se a página
 * escolhesse; no app ela escolhe de verdade. A parte que mais importa é a
 * última linha — "VAI SAIR: SÓ O JOGO · Minecraft" — porque uma trilha
 * existir não diz o que está nela. Fica num `role="status"`: quando o modo
 * muda ou a captura falha, é a frase que o leitor de tela anuncia.
 *
 * Só desenho. As opções e a lista de apps são `radiogroup`s: Tab entra no
 * grupo, as setas movem a seleção, e a opção desabilitada diz o motivo no
 * próprio cartão.
 */
export function SeletorDeSom({
  opcao,
  jogoDisponivel,
  motivoDoJogo,
  apps,
  appEscolhido,
  listando,
  real,
  avisoDoSistema,
  aoEscolherOpcao,
  aoEscolherApp,
  aoAtualizar,
}: Props) {
  const idOpcoes = useId();
  const idApps = useId();
  const jogoBloqueado = jogoDisponivel === false;
  const habilitadas = OPCOES.filter((o) => !(o.id === 'jogo' && jogoBloqueado)).map((o) => o.id);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h2 id={idOpcoes} className="rotulo m-0 text-[12px]">
        O QUE SEUS AMIGOS VÃO OUVIR?
      </h2>

      <div
        role="radiogroup"
        aria-labelledby={idOpcoes}
        onKeyDown={(e) => teclasDoGrupo(e, habilitadas, opcao, (id) => aoEscolherOpcao(id as OpcaoDeSom))}
        className="grid gap-2 sm:grid-cols-3"
      >
        {OPCOES.map((o) => {
          const marcada = o.id === opcao;
          const bloqueada = o.id === 'jogo' && jogoBloqueado;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              data-id={o.id}
              aria-checked={marcada}
              aria-disabled={bloqueada}
              tabIndex={marcada ? 0 : -1}
              onClick={() => {
                if (!bloqueada) aoEscolherOpcao(o.id);
              }}
              className={[
                'flex min-h-11 flex-col gap-1.5 border-2 p-3 text-left transition-colors duration-150 focus-visible:border-accent focus-visible:outline-none',
                bloqueada
                  ? 'cursor-not-allowed border-line bg-surface opacity-70'
                  : marcada
                    ? 'border-accent bg-warn-bg'
                    : 'border-line bg-surface hover:border-accent-lo',
              ].join(' ')}
            >
              <span className="flex items-center gap-2">
                {/* O glifo diz o estado sem depender da cor: ◉ marcado, ○ livre, × indisponível. */}
                <span aria-hidden="true" className={`font-[family-name:var(--font-pixel)] text-[13px] leading-none ${marcada ? 'text-accent' : 'text-dim'}`}>
                  {bloqueada ? '×' : marcada ? '◉' : '○'}
                </span>
                <span className={`font-[family-name:var(--font-pixel)] text-[12px] ${marcada ? 'text-accent-hi' : 'text-text'}`}>{o.nome}</span>
              </span>
              <span className="text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
                {bloqueada ? (motivoDoJogo ?? 'Indisponível neste sistema.') : o.texto}
              </span>
              {o.id === 'jogo' && jogoDisponivel === null && <span className="rotulo">VERIFICANDO…</span>}
            </button>
          );
        })}
      </div>

      {opcao === 'sistema' && avisoDoSistema !== null && (
        <p className="m-0 border-2 border-line bg-surface px-3.5 py-2.5 text-[11.5px] leading-relaxed text-muted [text-wrap:pretty]">{avisoDoSistema}</p>
      )}

      {opcao === 'jogo' && !jogoBloqueado && (
        <div className="flex flex-col gap-2 border-2 border-line bg-surface p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 id={idApps} className="rotulo m-0">
              PROGRAMAS COM SOM
            </h3>
            <Botao onClick={aoAtualizar}>
              ATUALIZAR
            </Botao>
          </div>

          {listando && apps.length === 0 && <p className="rotulo m-0 py-4 text-center">PROCURANDO…</p>}
          {!listando && apps.length === 0 && (
            <p className="m-0 py-3 text-center text-[11.5px] leading-relaxed text-muted [text-wrap:pretty]">
              Nenhum programa com som por enquanto. Abra o jogo e faça tocar alguma coisa — a lista se atualiza sozinha.
            </p>
          )}

          <div
            role="radiogroup"
            aria-labelledby={idApps}
            onKeyDown={(e) => teclasDoGrupo(e, apps.map((a) => a.id), appEscolhido, aoEscolherApp)}
            className="grid gap-1.5 sm:grid-cols-2"
          >
            {apps.map((a, i) => {
              const marcado = a.id === appEscolhido;
              // Sem nada escolhido, o primeiro item é o ponto de entrada do Tab.
              const entrada = marcado || (appEscolhido === null && i === 0);
              return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  data-id={a.id}
                  aria-checked={marcado}
                  tabIndex={entrada ? 0 : -1}
                  onClick={() => aoEscolherApp(a.id)}
                  title={a.nome}
                  className={[
                    'flex min-h-11 min-w-0 items-center gap-2.5 border-2 px-2.5 py-1.5 text-left transition-colors duration-150 focus-visible:border-accent focus-visible:outline-none',
                    marcado ? 'border-accent bg-warn-bg' : 'border-line bg-deep hover:border-accent-lo',
                  ].join(' ')}
                >
                  <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden border-2 border-line bg-surface">
                    {a.icone === null ? (
                      <span className="font-[family-name:var(--font-pixel)] text-[12px] text-accent">{a.nome.charAt(0).toUpperCase()}</span>
                    ) : (
                      <img src={a.icone} alt="" className="h-full w-full object-contain" draggable={false} />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate font-[family-name:var(--font-pixel)] text-[11px] ${marcado ? 'text-accent-hi' : 'text-text'}`}>{a.nome}</span>
                    {/* Texto, não só cor: quem não distingue âmbar de cinza lê "TOCANDO". */}
                    <span className="rotulo">{a.tocando ? 'TOCANDO' : 'EM SILÊNCIO'}</span>
                  </span>
                  {marcado && (
                    <span aria-hidden="true" className="font-[family-name:var(--font-pixel)] text-[13px] text-accent">
                      ◉
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <p
        role="status"
        className={[
          'm-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-2 px-3.5 py-2.5',
          real.tom === 'alerta' ? 'border-warn-edge bg-warn-bg' : 'border-accent-lo bg-deep',
        ].join(' ')}
      >
        <span className="rotulo">VAI SAIR</span>
        <span className={`font-[family-name:var(--font-pixel)] text-[12px] ${real.tom === 'alerta' ? 'text-warn' : 'text-accent-hi'}`}>
          {real.tom === 'alerta' && <span aria-hidden="true">! </span>}
          {real.rotulo}
        </span>
      </p>
    </div>
  );
}
