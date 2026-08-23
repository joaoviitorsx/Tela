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
                  : 'text-dim hover:bg-line hover:text-text',
              ].join(' ')}
            >
              {preset.label.replace(' econômico', '·eco')}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <fieldset className="w-full max-w-md" disabled={disabled}>
      <legend className="mb-2 text-[13px] text-dim">Qualidade</legend>

      <div className="grid gap-1.5">
        {presets.map((preset) => {
          const active = preset.id === value;
          return (
            <label
              key={preset.id}
              className={[
                'flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3',
                'transition-colors duration-150',
                active ? 'border-accent bg-surface' : 'border-line hover:border-muted',
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
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-line'}`}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="tabular block text-[15px] leading-tight">{preset.label}</span>
                <span className="block text-[13px] leading-tight text-dim">{preset.hint}</span>
              </span>
            </label>
          );
        })}
      </div>

      {forced && (
        <p role="status" className="mt-2 text-[13px] text-warn">
          Reduzido automaticamente: o encoder não estava dando conta. Você pode subir de novo.
        </p>
      )}
    </fieldset>
  );
}
