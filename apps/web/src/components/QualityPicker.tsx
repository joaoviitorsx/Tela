import type { EncodingPreset, PresetId } from '@tela/shared';

type Props = {
  readonly presets: readonly EncodingPreset[];
  readonly value: PresetId;
  readonly onChange: (id: PresetId) => void;
  /** Quando o preset atual foi imposto pela pressão de CPU, não escolhido. */
  readonly forced?: boolean;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  /**
   * O melhor degrau que o link MEDIDO sustenta. `undefined` sem medição.
   *
   * Escolher acima dele não é proibido — o usuário manda —, mas o produto para
   * de fingir que o rótulo é o resultado. Desde a ADR 0015 o orçamento decide a
   * resolução de verdade: pedir 1080p60 num link de 10 Mbps entrega 576p60, e
   * até agora nada na tela avisava disso antes de a pessoa começar.
   */
  readonly sustentavel?: PresetId;
};

/**
 * Escolha de qualidade, antes de iniciar e com a transmissão no ar.
 *
 * Rótulo diz resolução; a linha de baixo fala de REDE, não de pixel — é o que
 * o usuário consegue julgar ("minha internet aguenta?"). Trocar ao vivo
 * republica sem derrubar quem já está assistindo.
 */
export function QualityPicker({
  presets,
  value,
  onChange,
  forced = false,
  compact = false,
  disabled = false,
  sustentavel,
}: Props) {
  /**
   * Quais degraus o link medido NÃO paga.
   *
   * `presets` já vem do melhor para o pior, então tudo antes do sustentável
   * está acima do que a medição suporta. Eles continuam clicáveis — a escolha é
   * do usuário — só param de parecer promessa.
   */
  const limite = sustentavel === undefined ? -1 : presets.findIndex((p) => p.id === sustentavel);
  const acimaDoLink = (i: number) => limite >= 0 && i < limite;
  if (compact) {
    return (
      <div
        className="grid grid-cols-3 gap-1 rounded-md border border-edge bg-void p-1 sm:grid-cols-6"
        role="group"
        aria-label="Qualidade da transmissão"
      >
        {presets.map((preset, i) => {
          const active = preset.id === value;
          return (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(preset.id)}
              aria-pressed={active}
              title={preset.hint}
              className={[
                // Grade, não flex. Ver o bloco na variante completa.
                'tabular min-h-11 rounded-sm px-1 text-[12px] transition-colors duration-150',
                'disabled:opacity-40',
                active
                  ? 'bg-text text-void font-medium'
                  : acimaDoLink(i)
                    ? 'text-faint hover:bg-surface hover:text-muted'
                    : 'text-muted hover:bg-surface hover:text-text',
              ].join(' ')}
            >
              {preset.label.replace(' econômico', '·eco')}
            </button>
          );
        })}
      </div>
    );
  }

  /**
   * Uma linha, não quatro cartões.
   *
   * A tese da tela inicial é "um botão e um campo". Quatro cartões de escolha
   * empurravam o botão para 10% da página e transformavam a home num painel de
   * configuração — o oposto do produto. A escolha continua ali, com o mesmo
   * peso de uma escolha secundária, e a explicação aparece só do preset
   * selecionado, que é a única que interessa naquele instante.
   *
   * A `legend` saiu: quem rotula esta região agora é a serigrafia da chapa, e
   * dois títulos empilhados dizendo "Qualidade" seria a mesma palavra duas
   * vezes. O `fieldset` fica — é ele que agrupa os rádios para o leitor de
   * tela — e ganha um `aria-label` no lugar.
   *
   * Alvo de toque de 44px: eram 36 (`py-2` em 13px), o que reprovava no
   * celular, onde este é o único controle além do botão.
   */
  const selecionado = presets.find((preset) => preset.id === value);

  return (
    <fieldset className="w-full" aria-label="Qualidade da transmissão" disabled={disabled}>
      {/*
        Grade de três colunas no celular, linha única a partir de `sm`. Eram
        duas colunas, de quando a escada tinha quatro degraus; com seis, duas
        colunas viram três linhas e o controle fica mais alto que o botão
        primário. Com `flex-wrap` a quebra seria 4+2 e a segunda linha pareceria
        outro controle.
      */}
      <div
        data-vidro="contorno"
        className="grid grid-cols-3 gap-1 rounded-md border border-edge bg-void p-1 sm:grid-cols-6"
      >
        {presets.map((preset, i) => {
          const active = preset.id === value;
          return (
            <label
              key={preset.id}
              className={[
                /*
                  GRADE, e não flex, e a diferença é o que consertou o
                  desalinhamento da pílula.

                  `flex-1` do Tailwind já é `flex: 1 1 0%`, então a base zero
                  não era o problema: era `min-width: auto`, que impede um item
                  flex de encolher abaixo do próprio conteúdo. "1080p60" tem um
                  caractere a mais que os outros rótulos, então quando o espaço
                  apertava — 464px no layout de duas colunas — a célula dele
                  ficava 78px contra 71 das vizinhas, e a pílula branca do
                  selecionado saía visivelmente fora de alinhamento.

                  `grid-cols-6` do Tailwind emite `minmax(0, 1fr)`, que IGNORA o
                  min-content e produz colunas exatamente iguais em qualquer
                  largura.
                */
                'tabular flex min-h-11 cursor-pointer items-center justify-center',
                'rounded-sm px-1 text-center text-[13px]',
                'whitespace-nowrap transition-colors duration-150',
                /*
                  O rádio é `sr-only`, então o anel de foco do navegador ia
                  parar num elemento de 1px invisível: quem navega por teclado
                  atravessava os quatro presets sem nenhum sinal de onde
                  estava. `:has()` traz o anel para o rótulo, que é o que a
                  pessoa enxerga. Mesmas 2px de acento do anel global, para
                  não inventar um segundo vocabulário de foco.
                */
                'has-[:focus-visible]:outline has-[:focus-visible]:outline-2',
                'has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                active
                  ? 'bg-text font-medium text-void'
                  : acimaDoLink(i)
                    ? 'text-faint hover:bg-surface hover:text-muted'
                    : 'text-muted hover:bg-surface hover:text-text',
              ].join(' ')}
              title={acimaDoLink(i) ? `${preset.hint} — acima do que sua subida mediu` : preset.hint}
            >
              <input
                type="radio"
                name="preset"
                value={preset.id}
                checked={active}
                onChange={() => onChange(preset.id)}
                className="sr-only"
              />
              {preset.label.replace(' econômico', ' eco')}
            </label>
          );
        })}
      </div>

      <p className="mt-2 min-h-5 text-[13px] text-muted">{selecionado?.hint}</p>

      {/*
        O produto para de fingir que o rótulo é o resultado.

        Desde a ADR 0015 quem decide a resolução é o orçamento medido: pedir
        1080p60 num link que paga 4 Mbps entrega 576p60, e até aqui nada avisava
        antes de a pessoa começar — ela descobria olhando a imagem.
      */}
      {sustentavel !== undefined && limite > 0 && presets.findIndex((p) => p.id === value) < limite && (
        <p role="status" className="mt-1 text-[13px] text-warn">
          Sua última transmissão sustentou{' '}
          {presets[limite]?.label}. Acima disso a imagem desce sozinha para o que
          couber — o rótulo muda, a nitidez não melhora.
        </p>
      )}

      {forced && (
        <p role="status" className="mt-1 text-[13px] text-warn">
          Reduzido automaticamente: o encoder não estava dando conta. Você pode subir de novo.
        </p>
      )}
    </fieldset>
  );
}
