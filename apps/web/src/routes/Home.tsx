import { PRESETS, PRESET_ORDER, type PresetId } from '@tela/shared';
import { useCallback, useMemo, useState } from 'react';
import { BigButton } from '../components/BigButton.js';
import { IconPlay } from '../components/Icon.js';
import { QualityPicker } from '../components/QualityPicker.js';
import { SlugPicker } from '../components/SlugPicker.js';
import { api, identity, preferences } from '../container.js';
import { isPresetId } from '../core/media/presets.js';
import { useSlugCheck } from '../react/use-live-status.js';

type Props = { readonly onStart: (slug: string, presetId: PresetId) => void };

/**
 * Um botão e um campo. Sem header, sem logo, sem rodapé, sem "como funciona".
 *
 * Cada elemento aqui teve que justificar por que não é o botão de transmitir.
 * A escolha de qualidade passou porque é a única decisão que muda o resultado
 * e que só o usuário sabe responder — ele conhece a internet e a máquina dele.
 */
export function Home({ onStart }: Props) {
  const [slug, setSlug] = useState(() => identity.savedSlug() ?? '');
  const [presetId, setPresetId] = useState<PresetId>(() => {
    const saved = preferences.read();
    return isPresetId(saved) ? saved : 'p1080p60';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);

  const check = useSlugCheck(slug);
  const presets = useMemo(() => PRESET_ORDER.map((id) => PRESETS[id]), []);

  const choosePreset = useCallback((id: PresetId) => {
    setPresetId(id);
    preferences.write(id);
  }, []);

  const handleStart = useCallback(async () => {
    const wanted = slug.trim().toLowerCase();
    if (wanted.length === 0) return;

    setBusy(true);
    setError(null);
    setSuggestions([]);

    const result = await api.claim(wanted, identity.ownerToken());
    setBusy(false);

    if (!result.ok) {
      // 409 com o slug de outra pessoa: mostra as alternativas em vez de
      // devolver um erro seco e deixar o usuário inventar sozinho.
      setSuggestions(result.suggestions);
      setError(
        result.error === 'SLUG_TAKEN'
          ? 'Esse link já é de outra pessoa.'
          : result.error === 'SLUG_RESERVED'
            ? 'Esse nome não está disponível.'
            : result.error === 'RATE_LIMITED'
              ? 'Muitas tentativas. Espere um pouco.'
              : 'Não foi possível reservar o link agora.',
      );
      return;
    }

    identity.rememberSlug(result.value.slug);
    onStart(result.value.slug, presetId);
  }, [slug, presetId, onStart]);

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-8 px-6 py-16">
      <BigButton
        onClick={() => void handleStart()}
        busy={busy}
        disabled={slug.trim().length < 3}
        icon={<IconPlay className="h-4 w-4" />}
      >
        TRANSMITIR
      </BigButton>

      <SlugPicker
        value={slug}
        onChange={(value) => {
          setSlug(value);
          setError(null);
          setSuggestions([]);
        }}
        status={check.status}
        suggestions={suggestions}
        onPickSuggestion={(picked) => {
          setSlug(picked);
          setSuggestions([]);
          setError(null);
        }}
        error={error}
      />

      <QualityPicker presets={presets} value={presetId} onChange={choosePreset} />
    </main>
  );
}
