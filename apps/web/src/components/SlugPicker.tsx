import { IconCheck, IconWarning } from './Icon.js';

type Status = 'idle' | 'checking' | 'invalid' | 'free' | 'live';

type Props = {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly status: Status;
  readonly suggestions?: readonly string[];
  readonly onPickSuggestion?: (slug: string) => void;
  readonly error?: string | null;
};

const LABEL: Record<Status, string> = {
  idle: '',
  checking: 'verificando',
  invalid: '3 a 25 caracteres: letras minúsculas, números e hífen. Não pode começar nem terminar com hífen.',
  free: 'esse link é válido',
  live: 'alguém está transmitindo neste link agora',
};

/**
 * Campo único. O prefixo do domínio fica DENTRO do campo, não numa label
 * acima: o usuário está escolhendo o final de uma URL que ele já vê inteira.
 *
 * O estado não é comunicado só por cor. Antes havia um ponto verde/vermelho e
 * nada mais — invisível para daltônico e para quem tem a tela em luz forte.
 * Agora vem ícone e frase; a cor só reforça.
 */
export function SlugPicker({
  value,
  onChange,
  status,
  suggestions = [],
  onPickSuggestion,
  error,
}: Props) {
  const problema = status === 'invalid' || Boolean(error);
  const mensagem = error ?? LABEL[status];

  return (
    <div className="w-full max-w-md">
      <label htmlFor="slug" className="sr-only">
        Escolha o final do seu link
      </label>

      <div
        className={[
          'flex items-center rounded-md border bg-surface transition-colors duration-150',
          problema ? 'border-danger' : 'border-edge focus-within:border-text',
        ].join(' ')}
      >
        <span className="tabular select-none py-3 pl-4 text-[15px] text-muted">tela.gg/</span>
        <input
          id="slug"
          value={value}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          placeholder="seunome"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={25}
          aria-describedby="slug-status"
          aria-invalid={problema}
          className="tabular min-w-0 flex-1 bg-transparent py-3 pr-4 text-[15px] outline-none placeholder:text-faint"
        />
      </div>

      <p
        id="slug-status"
        role="status"
        className={`mt-2 flex min-h-5 items-start gap-1.5 text-[13px] ${
          problema ? 'text-danger' : 'text-muted'
        }`}
      >
        {mensagem !== '' &&
          (problema ? (
            <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : status === 'free' ? (
            <IconCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : null)}
        {mensagem}
      </p>

      {suggestions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {suggestions.map((slug) => (
            <button
              key={slug}
              type="button"
              onClick={() => onPickSuggestion?.(slug)}
              className="tabular rounded-sm border border-edge px-2.5 py-1.5 text-[13px] text-muted transition-colors duration-150 hover:border-text hover:text-text"
            >
              {slug}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
