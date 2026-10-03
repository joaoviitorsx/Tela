import { useId, useState } from 'react';
import { BotaoBarra, type PropsDaBarra } from './BarraEspectador.js';
import { VolumeBlocos } from './VolumeBlocos.js';
import { IconMaisTela, IconMudo, IconOlho, IconOlhoRisco, IconPip, IconSairTelaCheia, IconSom, IconTelaCheia } from './Icon.js';
import { Led } from './Led.js';

/**
 * A barra do espectador em celular (V-01, V-02): uma linha de 44px com o que
 * se quer o tempo todo — AO VIVO, quantos, latência, som e tela cheia — e o
 * resto (zoom, picture-in-picture, diagnóstico, abrir no app, esconder) atrás
 * de `⋯`. A de duas ou três linhas comia 31% de um celular deitado.
 *
 * Mesmos dados e mesmos callbacks da barra cheia (`PropsDaBarra`): só muda o
 * desenho. No celular o volume é o do aparelho e aqui fica o botão de mudo;
 * com mouse (janela baixa no PC) vai o deslizante inteiro.
 */
export function BarraEspectadorCompacta(p: PropsDaBarra) {
  const [mais, setMais] = useState(false);
  const idMais = useId();

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col gap-1 p-2">
      {mais && (
        <div
          id={idMais}
          className="pointer-events-auto flex flex-wrap items-center border-2 border-edge bg-[rgb(10_10_12_/_0.95)]"
        >
          <div className="flex items-center" role="group" aria-label="Zoom">
            <BotaoBarra rotulo="Diminuir zoom (−)" aoClicar={p.zoom.aoDiminuir}>
              <span className="font-[family-name:var(--font-pixel)] text-[18px]">−</span>
            </BotaoBarra>
            <button
              type="button"
              onClick={p.zoom.aoResetar}
              aria-label={`Zoom ${p.zoom.porcento}. Voltar para 100%`}
              className={`numeral h-11 min-w-[54px] border-0 bg-transparent px-1 text-[22px] ${p.zoom.ampliado ? 'text-accent-hi' : 'text-text'}`}
            >
              {p.zoom.porcento}
            </button>
            <BotaoBarra rotulo="Aumentar zoom (+)" aoClicar={p.zoom.aoAumentar}>
              <span className="font-[family-name:var(--font-pixel)] text-[18px]">+</span>
            </BotaoBarra>
          </div>
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
          <button
            type="button"
            onClick={p.aoCopiarDiagnostico}
            aria-label="Copiar diagnóstico técnico desta sessão"
            className="h-11 border-0 bg-transparent px-3 font-[family-name:var(--font-pixel)] text-[11px] text-muted"
          >
            {p.copiouDiagnostico ? 'COPIADO' : 'DIAGNÓSTICO'}
          </button>
          {p.abrirNoApp != null && (
            <button
              type="button"
              onClick={p.abrirNoApp.aoAbrir}
              disabled={p.abrirNoApp.tentando}
              aria-label="Abrir este canal no Tela Desktop"
              className="h-11 border-0 bg-transparent px-3 font-[family-name:var(--font-pixel)] text-[11px] text-muted disabled:opacity-60"
            >
              {p.abrirNoApp.tentando ? 'ABRINDO…' : p.abrirNoApp.falhou ? '! SEM APP' : 'ABRIR NO APP'}
            </button>
          )}
          <BotaoBarra rotulo="Esconder controles (H)" aoClicar={p.aoEsconder} largo>
            <IconOlhoRisco className="h-5 w-5 text-text" />
          </BotaoBarra>
        </div>
      )}

      <div className="pointer-events-auto flex h-11 items-stretch border-2 border-edge bg-[rgb(10_10_12_/_0.93)]">
        <div
          className={[
            'flex items-center gap-1.5 px-2.5 font-[family-name:var(--font-pixel)] text-[11px] font-bold',
            p.reconectando ? 'bg-warn-bg text-accent-hi' : 'bg-live text-white',
          ].join(' ')}
        >
          {p.reconectando ? <span aria-hidden="true">!</span> : <Led cor="branco" pisca />}
          {p.reconectando ? 'RECONECTANDO' : 'AO VIVO'}
        </div>

        <span className="sr-only">{p.canal}</span>

        {p.viewers !== null && (
          <span
            className="numeral flex items-center gap-1 px-2.5 text-[20px] text-text"
            aria-label={`${p.viewers} ${p.viewers === 1 ? 'pessoa assistindo' : 'pessoas assistindo'}`}
          >
            <IconOlho className="h-3 w-3 text-accent" />
            {p.viewers}
          </span>
        )}

        <span
          title={p.latenciaTitulo}
          className={`numeral flex items-center px-1.5 text-[20px] ${p.latenciaAlta ? 'text-warn' : 'text-accent-hi'}`}
        >
          {p.latencia}
        </span>

        {p.avisoImagem !== null && (
          <span
            className="flex items-center px-1.5 font-[family-name:var(--font-pixel)] text-[10px] text-warn"
            title={p.avisoImagem.titulo}
          >
            ! {p.avisoImagem.rotulo}
          </span>
        )}

        {p.travado !== null && (
          <span className="numeral flex items-center px-1.5 text-[18px] text-warn" title="Imagem congelada nesta sessão">
            {p.travado}
          </span>
        )}

        <div className="ml-auto flex items-center">
          {!p.temAudio || p.volume.deslizanteNaCompacta ? (
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
          ) : (
            <BotaoBarra
              rotulo="Silenciar"
              aoClicar={p.volume.aoAlternar}
              pressionado={p.volume.mudo}
            >
              {p.volume.mudo ? <IconMudo className="h-[18px] w-[18px]" /> : <IconSom className="h-[18px] w-[18px]" />}
            </BotaoBarra>
          )}
          {p.multivisao != null && (
            <BotaoBarra rotulo="Assistir outro canal junto (A)" aoClicar={p.multivisao.aoAdicionar}>
              <IconMaisTela className="h-[18px] w-[18px]" />
            </BotaoBarra>
          )}
          <BotaoBarra
            rotulo={p.emTelaCheia ? 'Sair da tela cheia (F)' : 'Tela cheia (F)'}
            aoClicar={p.aoTelaCheia}
          >
            {p.emTelaCheia ? (
              <IconSairTelaCheia className="h-4 w-4 text-accent" />
            ) : (
              <IconTelaCheia className="h-4 w-4 text-accent" />
            )}
          </BotaoBarra>
          <button
            type="button"
            onClick={() => setMais((v) => !v)}
            aria-expanded={mais}
            aria-controls={idMais}
            aria-label="Mais controles"
            className="flex h-11 w-11 items-center justify-center border-0 border-l-2 border-line bg-transparent p-0 font-[family-name:var(--font-pixel)] text-[18px] text-text hover:bg-key hover:text-accent-hi"
          >
            ⋯
          </button>
        </div>
      </div>
    </div>
  );
}
