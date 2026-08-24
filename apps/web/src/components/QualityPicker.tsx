import type { EncodingPreset, PresetId } from '@tela/shared';

type Props = {
  readonly presets: readonly EncodingPreset[];
  readonly value: PresetId;
  readonly onChange: (id: PresetId) => void;
  /** Quando o preset atual foi imposto pela pressão de CPU, não escolhido. */
  readonly forced?: boolean;
  readonly compact?: boolean;
  readonly disabled?: boolean;
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
}: Props) {
  if (compact) {
    return (
      <div
        className="grid grid-cols-3 gap-1 rounded-md border border-edge bg-void p-1 sm:flex sm:items-center"
        role="group"
        aria-label="Qualidade da transmissão"
      >
        {presets.map((preset) => {
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
                'tabular min-h-11 flex-1 rounded-sm px-2 text-[12px] transition-colors duration-150',
                'disabled:opacity-40',
                active
                  ? 'bg-text text-void font-medium'
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
        className="grid grid-cols-3 gap-1 rounded-md border border-edge bg-void p-1 sm:flex"
      >
        {presets.map((preset) => {
          const active = preset.id === value;
          return (
            <label
              key={preset.id}
              className={[
                'tabular flex min-h-11 flex-1 cursor-pointer items-center justify-center',
                'rounded-sm px-3 text-center text-[13px]',
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
                  : 'text-muted hover:bg-surface hover:text-text',
              ].join(' ')}
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

      {forced && (
        <p role="status" className="mt-1 text-[13px] text-warn">
          Reduzido automaticamente: o encoder não estava dando conta. Você pode subir de novo.
        </p>
      )}
    </fieldset>
  );
}
