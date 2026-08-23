import { PRESETS, PRESET_ORDER, type PresetId } from '@tela/shared';
import { useCallback, useMemo, useState } from 'react';
import { BigButton } from '../components/BigButton.js';
import { IconPlay } from '../components/Icon.js';
import { QualityPicker } from '../components/QualityPicker.js';
import { SlugPicker } from '../components/SlugPicker.js';
import { identity, preferences } from '../container.js';
import { isPresetId } from '../core/media/presets.js';
import { useSlugCheck } from '../react/use-slug-check.js';

type Props = { readonly onStart: (slug: string, presetId: PresetId) => void };

/**
 * Um botão e um campo. Sem header, sem logo, sem rodapé, sem "como funciona".
 *
 * Cada elemento aqui teve que justificar por que não é o botão de transmitir.
 * A escolha de qualidade passou porque é a única decisão que muda o resultado
 * e que só o usuário sabe responder — ele conhece a internet e a máquina dele.
 *
 * Não há mais reserva de slug antes de transmitir: sem API HTTP, quem decide
 * se o nome está livre é o servidor de sinalização, no `host`. O usuário
 * descobre ao apertar TRANSMITIR. Em troca, digitar não faz uma requisição por
 * tecla e não existe endpoint que sirva para varrer quem existe.
 */
export function Home({ onStart }: Props) {
  const [slug, setSlug] = useState(() => identity.savedSlug() ?? '');
  const [presetId, setPresetId] = useState<PresetId>(() => {
    const saved = preferences.read();
    return isPresetId(saved) ? saved : 'p1080p60';
  });

  const check = useSlugCheck(slug);
  const presets = useMemo(() => PRESET_ORDER.map((id) => PRESETS[id]), []);

  const choosePreset = useCallback((id: PresetId) => {
    setPresetId(id);
    preferences.write(id);
  }, []);

  const handleStart = useCallback(() => {
    const wanted = slug.trim().toLowerCase();
    if (check.status !== 'ok') return;
    identity.rememberSlug(wanted);
    onStart(wanted, presetId);
  }, [slug, check, presetId, onStart]);

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-8 px-6 py-16">
      <BigButton
        onClick={handleStart}
        disabled={check.status !== 'ok'}
        icon={<IconPlay className="h-4 w-4" />}
      >
        TRANSMITIR
      </BigButton>

      <SlugPicker
        value={slug}
        onChange={setSlug}
        status={check.status === 'ok' ? 'free' : check.status === 'invalid' ? 'invalid' : 'idle'}
        error={check.status === 'invalid' ? check.message : null}
      />

      <QualityPicker presets={presets} value={presetId} onChange={choosePreset} />
    </main>
  );
}
