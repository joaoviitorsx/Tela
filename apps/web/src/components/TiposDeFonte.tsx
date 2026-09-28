import { Aviso } from './Aviso.js';

const TIPOS = [
  {
    nome: 'TELA INTEIRA',
    recomendado: true,
    sub: 'O caminho recomendado. É o único modo em que o som do sistema acompanha o vídeo, e o mais leve para a sua placa.',
  },
  {
    nome: 'JANELA',
    recomendado: false,
    sub: 'Só o jogo, sem o resto da área de trabalho. O som do sistema não vai junto.',
  },
  {
    nome: 'ABA',
    recomendado: false,
    sub: 'Uma aba do Chrome, com o som dela. Serve para vídeo e site, não para jogo.',
  },
] as const;

/**
 * O que dá para escolher na caixa do navegador, como ORIENTAÇÃO.
 *
 * O protótipo listava as janelas abertas com miniatura. A web não enumera
 * janelas: quem escolhe é o seletor do Chrome, que abre ao apertar
 * "IR AO AR". Fingir uma lista aqui daria uma escolha que não vale — então
 * o que sobra para mostrar, com honestidade, é o que cada TIPO de fonte
 * significa para a imagem e para o som.
 *
 * Nada aqui é selecionável, e por isso nada aqui é botão nem tem estado
 * "marcado": seria um controle que não controla.
 */
export function TiposDeFonte() {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h2 className="rotulo m-0 text-[12px]">O QUE VOCÊ VAI TRANSMITIR?</h2>

      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {TIPOS.map((t) => (
          <li
            key={t.nome}
            className="grid grid-cols-[104px_minmax(0,1fr)] border-2 border-line bg-surface sm:grid-cols-[148px_minmax(0,1fr)]"
          >
            <div
              aria-hidden="true"
              className="flex items-center justify-center bg-[repeating-linear-gradient(135deg,#15130f_0_10px,#1b1812_10px_20px)]"
            >
              <span className="rotulo px-1 text-center text-faint">{t.nome}</span>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rotulo-forte">{t.nome}</span>
                {t.recomendado && (
                  <span className="bg-accent px-1.5 py-0.5 font-[family-name:var(--font-pixel)] text-[11px] leading-none text-ink">
                    RECOMENDADO
                  </span>
                )}
              </div>
              <p className="m-0 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">{t.sub}</p>
            </div>
          </li>
        ))}
      </ul>

      <Aviso>
        No navegador, o Chrome ainda confirma a escolha numa janela própria, quando você apertar
        “ir ao ar”. É lá que você marca tela, janela ou aba.
      </Aviso>
    </div>
  );
}
