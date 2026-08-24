import type { ReactNode } from 'react';

type Props = {
  readonly children: ReactNode;
  readonly className?: string;
};

/**
 * A chapa. Uma por tela, não uma por bloco.
 *
 * A saída óbvia para "a tela está vazia" seria espalhar cartões — e cartão com
 * sombra é exatamente o cromo de aplicativo que a anti-referência
 * (Zoom/Teams/Meet) usa. Aqui o desenho vem do outro lado: **uma chapa só**,
 * gravada por filetes em regiões, como o painel frontal de um aparelho de
 * vídeo. É de onde vem a referência do produto (Parsec).
 *
 * A regra de preenchimento é o que sustenta o contraste, e não é estética:
 *
 * - a chapa fica em `void`, então todo CONTROLE dentro dela mantém o contorno
 *   `edge` a 3,13:1 sobre `void` — medido, e é o mínimo da WCAG 1.4.11;
 * - `surface` preenche só as regiões que NÃO se toca (faixa de identificação,
 *   coluna de texto, rodapé de leitura). `edge` sobre `surface` mede 2,92:1 e
 *   reprovaria, então nenhum controle senta ali.
 *
 * Efeito colateral bom: o olho separa sozinho o que é para ler do que é para
 * apertar, sem precisar de cor nenhuma.
 *
 * A borda é `line` — 1,22:1, invisível de propósito, como manda a tabela de
 * tokens. Ela não informa que existe uma chapa; ela só impede que as regiões
 * `surface` pareçam recortes soltos no fundo.
 */
export function Panel({ children, className = '' }: Props) {
  return (
    <div className={`overflow-hidden rounded-md border border-line bg-void ${className}`}>
      {children}
    </div>
  );
}

type SecaoProps = {
  readonly rotulo?: string;
  readonly acessorio?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
};

/**
 * Uma região gravada na chapa: serigrafia em cima, conteúdo embaixo.
 *
 * O rótulo é opcional porque nem toda região tem nome — a que contém o botão
 * principal não tem, e não deveria ter: nomear "AÇÃO" um botão escrito
 * TRANSMITIR é escrever a mesma coisa duas vezes.
 */
export function PanelSection({ rotulo, acessorio, children, className = '' }: SecaoProps) {
  return (
    <section className={`px-4 py-5 sm:px-6 ${className}`}>
      {rotulo !== undefined && (
        <div className="mb-3 flex items-center gap-3">
          <h2 className="serigrafia">{rotulo}</h2>
          {acessorio !== undefined && <span className="ml-auto">{acessorio}</span>}
        </div>
      )}
      {children}
    </section>
  );
}
