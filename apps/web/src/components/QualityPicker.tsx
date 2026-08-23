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
      <div className="flex items-center gap-1" role="group" aria-label="Qualidade da transmissão">
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
                'tabular min-h-8 rounded-sm px-2.5 text-[12px] transition-colors duration-150',
                'disabled:opacity-40',
                active
                  ? 'bg-text text-void font-medium'
                  : 'text-muted hover:bg-void hover:text-text',
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
   */
  const selecionado = presets.find((preset) => preset.id === value);

  return (
    <fieldset className="w-full max-w-md" disabled={disabled}>
      <legend className="mb-2 text-[13px] text-muted">Qualidade</legend>

      <div className="flex flex-wrap gap-1 rounded-md border border-edge bg-surface p-1">
        {presets.map((preset) => {
          const active = preset.id === value;
          return (
            <label
              key={preset.id}
              className={[
                'tabular flex-1 cursor-pointer rounded-sm px-3 py-2 text-center text-[13px]',
                'whitespace-nowrap transition-colors duration-150',
                active ? 'bg-text font-medium text-void' : 'text-muted hover:bg-void hover:text-text',
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
