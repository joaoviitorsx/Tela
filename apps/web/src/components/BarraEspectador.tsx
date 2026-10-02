import { IconOlho, IconOlhoRisco, IconPip, IconSairTelaCheia, IconTelaCheia } from './Icon.js';
import { Led } from './Led.js';
import { VolumeBlocos } from './VolumeBlocos.js';

export type PropsDaBarra = {
  readonly canal: string;
  readonly viewers: number | null;
  readonly reconectando: boolean;
  readonly latencia: string;
  readonly latenciaAlta: boolean;
  readonly latenciaTitulo: string;
  readonly imagem: string;
  /** "2,1s travado", ou `null` quando nunca travou: silêncio é boa notícia. */
  readonly travado: string | null;
  readonly avisoAudio: { readonly rotulo: string; readonly titulo: string } | null;

  readonly temAudio: boolean;
  readonly volume: {
    readonly valor: number;
    readonly mudo: boolean;
    readonly ajustavel: boolean;
    readonly passo: number;
    readonly aoAjustar: (v: number) => void;
    readonly aoAlternar: () => void;
    readonly aoAtivar: (ativo: boolean) => void;
    /**
     * Na barra compacta, também o deslizante — não só o mudo. `false` no
     * celular, onde o volume é o do aparelho (botões laterais).
     */
    readonly deslizanteNaCompacta: boolean;
  };

  readonly zoom: {
    readonly porcento: string;
    readonly ampliado: boolean;
    readonly aoAumentar: () => void;
    readonly aoDiminuir: () => void;
    readonly aoResetar: () => void;
  };

  readonly aoEsconder: () => void;
  /** `null` = o navegador não tem picture-in-picture: o botão não existe. */
  readonly pip: { readonly ativo: boolean; readonly aoAlternar: () => void } | null;
  readonly emTelaCheia: boolean;
  readonly aoTelaCheia: () => void;
  readonly copiouDiagnostico: boolean;
  readonly aoCopiarDiagnostico: () => void;
  /**
   * ABRIR NO APP, discreto. `null` onde não há app (celular, Mac, Safari) ou
   * onde a página já é o app. `falhou`: a última tentativa não achou o Tela.
   */
  readonly abrirNoApp?: {
    readonly aoAbrir: () => void;
    readonly tentando: boolean;
    readonly falhou: boolean;
  } | null;
};

/**
 * A barra de baixo do espectador: tudo que ele pode querer e nada que não
 * possa. Some sozinha com o mouse parado (`use-auto-hide`), ou pelo botão/`H`.
 *
 * Cada campo é um número que existe: latência medida, imagem MEDIDA (a que
 * chega, não a que o transmissor pediu), contagem de quem assiste. O que o
 * protótipo mostrava mas a sessão não tem — o número do canal — não está aqui.
 *
 * Tudo em botão de 44px, rótulos de tooltip no `title` E `aria-label`. Atalhos
 * (`H`, `F`, `P`, `M`, `+`/`-`) estão nos rótulos: descobrir tecla lendo é o
 * único jeito que o espectador tem.
 */
export function BarraEspectador(p: PropsDaBarra) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 p-3 sm:p-5">
      <div className="pointer-events-auto flex flex-wrap items-stretch border-2 border-edge bg-[rgb(10_10_12_/_0.93)]">
        <div
          className={[
            'flex items-center gap-2 px-3.5 font-[family-name:var(--font-pixel)] text-[12px] font-bold',
            p.reconectando ? 'bg-warn-bg text-accent-hi' : 'bg-live text-white',
          ].join(' ')}
        >
          {p.reconectando ? (
            <span aria-hidden="true">!</span>
          ) : (
            <Led cor="branco" pisca />
          )}
          {p.reconectando ? 'RECONECTANDO' : 'AO VIVO'}
        </div>

        <div className="flex min-w-[130px] flex-1 flex-col justify-center gap-0.5 px-4 py-2">
          <span className="truncate text-[13px] font-medium text-text">
            {p.canal}
          </span>
        </div>

        {p.viewers !== null && (
          <Campo rotulo="JUNTO">
            <span
              className="numeral flex items-center gap-1.5 text-[22px] text-text"
              aria-label={`${p.viewers} ${p.viewers === 1 ? 'pessoa assistindo' : 'pessoas assistindo'}`}
            >
              <IconOlho className="h-3.5 w-3.5 text-accent" />
              {p.viewers}
            </span>
          </Campo>
        )}

        <Campo rotulo="LATÊNCIA" titulo={p.latenciaTitulo}>
          <span className={`numeral text-[22px] ${p.latenciaAlta ? 'text-warn' : 'text-accent-hi'}`}>
            {p.latencia}
          </span>
        </Campo>

        <Campo rotulo="IMAGEM" titulo="Resolução que está chegando de verdade">
          <span className="numeral text-[22px] text-text">{p.imagem}</span>
        </Campo>

        {p.travado !== null && (
          <Campo rotulo="TRAVOU" titulo="Tempo total de imagem congelada nesta sessão">
            <span className="numeral text-[22px] text-warn">{p.travado}</span>
          </Campo>
        )}

        {p.avisoAudio !== null && (
          <Campo rotulo="SOM" titulo={p.avisoAudio.titulo}>
            <span className="font-[family-name:var(--font-pixel)] text-[11px] text-warn">
              ! {p.avisoAudio.rotulo}
            </span>
          </Campo>
        )}

        <div className="flex items-center border-l-2 border-line px-1.5">
          <VolumeBlocos
            volume={p.volume.valor}
            mudo={p.volume.mudo}
            ajustavel={p.volume.ajustavel}
            passo={p.volume.passo}
            onVolume={p.volume.aoAjustar}
            onAlternar={p.volume.aoAlternar}
            onAtivo={p.volume.aoAtivar}
            semSom={!p.temAudio}
          />
        </div>

        <div className="flex items-center border-l-2 border-line" role="group" aria-label="Zoom">
          <BotaoBarra rotulo="Diminuir zoom (−)" aoClicar={p.zoom.aoDiminuir}>
            <span className="font-[family-name:var(--font-pixel)] text-[18px]">−</span>
          </BotaoBarra>
          <button
            type="button"
            onClick={p.zoom.aoResetar}
            title="Voltar para 100%"
            aria-label={`Zoom ${p.zoom.porcento}. Voltar para 100%`}
            className={`numeral h-11 min-w-[54px] border-0 bg-transparent px-1 text-[22px] hover:bg-key ${p.zoom.ampliado ? 'text-accent-hi' : 'text-text'}`}
          >
            {p.zoom.porcento}
          </button>
          <BotaoBarra rotulo="Aumentar zoom (+)" aoClicar={p.zoom.aoAumentar}>
            <span className="font-[family-name:var(--font-pixel)] text-[18px]">+</span>
          </BotaoBarra>
        </div>

        <button
          type="button"
          onClick={p.aoCopiarDiagnostico}
          aria-label="Copiar diagnóstico técnico desta sessão"
          className="h-11 border-0 border-l-2 border-line bg-transparent px-3 font-[family-name:var(--font-pixel)] text-[11px] text-muted hover:bg-key hover:text-accent-hi"
        >
          {p.copiouDiagnostico ? 'COPIADO' : 'DIAGNÓSTICO'}
        </button>

        {p.abrirNoApp != null && (
          <button
            type="button"
            onClick={p.abrirNoApp.aoAbrir}
            disabled={p.abrirNoApp.tentando}
            title={
              p.abrirNoApp.falhou
                ? 'O Tela Desktop não respondeu. Ele está instalado?'
                : 'Abrir este canal no Tela Desktop'
            }
            aria-label="Abrir este canal no Tela Desktop"
            className="h-11 border-0 border-l-2 border-line bg-transparent px-3 font-[family-name:var(--font-pixel)] text-[11px] text-muted hover:bg-key hover:text-accent-hi disabled:opacity-60"
          >
            {p.abrirNoApp.tentando ? 'ABRINDO…' : p.abrirNoApp.falhou ? '! SEM APP' : 'ABRIR NO APP'}
          </button>
        )}

        <div className="ml-auto flex items-center border-l-2 border-edge">
          <BotaoBarra rotulo="Esconder controles (H)" aoClicar={p.aoEsconder} largo>
            <IconOlhoRisco className="h-5 w-5 text-text" />
          </BotaoBarra>
          {p.pip !== null && (
            <BotaoBarra
              rotulo={p.pip.ativo ? 'Sair do picture-in-picture (P)' : 'Picture-in-picture (P)'}
              aoClicar={p.pip.aoAlternar}
              largo
              pressionado={p.pip.ativo}
            >
              <IconPip className="h-[18px] w-[18px] text-text" />
            </BotaoBarra>
          )}
          <BotaoBarra
            rotulo={p.emTelaCheia ? 'Sair da tela cheia (F)' : 'Tela cheia (F)'}
            aoClicar={p.aoTelaCheia}
            largo
          >
            {p.emTelaCheia ? (
              <IconSairTelaCheia className="h-4 w-4 text-accent" />
            ) : (
              <IconTelaCheia className="h-4 w-4 text-accent" />
            )}
          </BotaoBarra>
        </div>
      </div>
    </div>
  );
}

function Campo({
  rotulo,
  titulo,
  children,
}: {
  readonly rotulo: string;
  readonly titulo?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      {...(titulo === undefined ? {} : { title: titulo })}
      className="flex flex-col justify-center gap-0.5 border-l-2 border-line px-3.5 py-1.5"
    >
      <span className="rotulo">{rotulo}</span>
      {children}
    </div>
  );
}

export function BotaoBarra({
  rotulo,
  aoClicar,
  largo = false,
  pressionado,
  children,
}: {
  readonly rotulo: string;
  readonly aoClicar: () => void;
  readonly largo?: boolean;
  readonly pressionado?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={aoClicar}
      title={rotulo}
      aria-label={rotulo}
      {...(pressionado === undefined ? {} : { 'aria-pressed': pressionado })}
      className={[
        'flex h-11 items-center justify-center border-0 bg-transparent p-0 text-text hover:bg-key hover:text-accent-hi',
        largo ? 'w-12' : 'w-11',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
