import type { ReactNode } from 'react';
import { Medidor, type Medida } from './Medidor.js';

type Props = {
  /**
   * `normal`: a TV desligando. `aviso`: escolha da pessoa ou algo que ela
   * resolve (moldura âmbar, sem alarme). `falha`: barras de cor e chiado.
   */
  readonly tom: 'normal' | 'aviso' | 'falha';
  /** Linha grande do tubo: o motivo, em poucas palavras. */
  readonly titulo: string;
  readonly mensagem: string;
  /** "tela.gg/canal". */
  readonly canal: string;
  readonly resumo: readonly Medida[] | null;
  readonly acoes: ReactNode;
  readonly diagnostico: ReactNode;
};

/** As barras de cor de "fora do ar", apagadas para caber na paleta. */
const BARRAS = ['#c9c3b0', '#c9b23a', '#3aa8a8', '#3aa84a', '#a83aa0', '#a8403a', '#3a4ea8'];

/**
 * A tela depois do ar: a TV desligando.
 *
 * Fim normal (e aviso): a imagem colapsa numa linha, vira um ponto e apaga — o CRT
 * perdendo o feixe —, e a mensagem acende no tubo escuro. Falha: barras de cor
 * e chiado, o "fora do ar" de qualquer TV. As duas usam o mesmo aparelho das
 * telas de antes (moldura do tubo, vidro, fonte de placar), então o fim parece
 * parte do produto e não uma caixa de erro.
 *
 * Sem movimento (`prefers-reduced-motion`), tudo aparece já no estado final.
 */
export function FimDeTransmissao({ tom, titulo, mensagem, canal, resumo, acoes, diagnostico }: Props) {
  const falhou = tom === 'falha';
  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col items-center gap-6">
      <div
        className={[
          // Largura limitada pela ALTURA da janela: o tubo e os botões cabem sem rolar.
          'relative aspect-video w-[min(100%,calc(52dvh*16/9))] overflow-hidden rounded-[28px] border-[3px] bg-black',
          'shadow-[inset_0_0_140px_rgb(0_0_0_/_0.95),0_0_0_2px_#000,0_30px_80px_rgb(0_0_0_/_0.6)]',
          falhou ? 'border-danger-edge' : tom === 'aviso' ? 'border-warn-edge' : 'border-edge',
        ].join(' ')}
      >
        {falhou ? (
          <>
            <div aria-hidden="true" className="absolute inset-0 flex opacity-35">
              {BARRAS.map((cor) => (
                <span key={cor} className="h-full flex-1" style={{ backgroundColor: cor }} />
              ))}
            </div>
            <div aria-hidden="true" className="chiado chiado-anda absolute inset-0 opacity-45 mix-blend-screen" />
          </>
        ) : (
          <>
            {/* A última imagem, clara, colapsando. Nasce invisível: a animação a mostra. */}
            <div
              aria-hidden="true"
              className="tv-desligando absolute inset-0 origin-center bg-[radial-gradient(ellipse_at_center,#fff6e0_0%,#f5c66b_35%,#3a2c14_100%)] opacity-0"
            />
            <span
              aria-hidden="true"
              className="tv-ponto absolute left-1/2 top-1/2 h-2.5 w-2.5 rounded-full bg-[#fff6e0] opacity-0 shadow-[0_0_40px_12px_rgb(245_198_107_/_0.75)]"
            />
          </>
        )}

        {/* Scanlines só no tubo; o reflexo do vidro por cima. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,rgb(0_0_0_/_0.45)_0_1px,transparent_1px_3px)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[26px] bg-[radial-gradient(ellipse_120%_80%_at_30%_10%,rgb(255_255_255_/_0.06),transparent_55%)]"
        />

        <div className="tv-mensagem absolute inset-0 flex items-center justify-center p-4 sm:p-6">
          <div
            className={[
              'flex flex-col items-center gap-3 text-center',
              // Sobre as barras de cor o texto precisa de chão.
              falhou ? 'border-2 border-danger-edge bg-black/80 px-5 py-4 sm:px-8 sm:py-6' : '',
            ].join(' ')}
          >
            <span className="rotulo !text-muted">CANAL · {canal}</span>
            <h1
              className={[
                'numeral m-0 leading-[0.9]',
                // Título de motivo ("NÃO FOI POSSÍVEL CAPTURAR A TELA") não cabe em 92px.
                titulo.length > 22
                  ? 'text-[clamp(24px,4vw,52px)]'
                  : titulo.length > 14
                    ? 'text-[clamp(28px,5vw,72px)]'
                    : 'text-[clamp(32px,6vw,92px)]',
                falhou
                  ? 'text-danger [text-shadow:0_0_22px_rgb(255_106_82_/_0.45),3px_3px_0_#000]'
                  : 'text-accent-hi [text-shadow:0_0_22px_rgb(242_169_59_/_0.5),3px_3px_0_#000]',
              ].join(' ')}
            >
              {titulo}
            </h1>
            <p
              role="status"
              className={`m-0 max-w-[52ch] text-[13px] leading-relaxed [text-wrap:pretty] ${tom === 'normal' ? 'text-muted' : 'text-warn'}`}
            >
              {mensagem}
            </p>
          </div>
        </div>
      </div>

      {resumo !== null && (
        <div className="w-full border-2 border-line bg-surface">
          <Medidor rotulo="Resumo da transmissão" medidas={resumo} colunas={3} tamanho="m" />
        </div>
      )}

      <div className="flex w-full flex-wrap items-center justify-center gap-3">{acoes}</div>

      {diagnostico}
    </div>
  );
}
