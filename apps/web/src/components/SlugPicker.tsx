type Status = 'idle' | 'checking' | 'invalid' | 'free' | 'live';

type Props = {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly status: Status;
  readonly suggestions?: readonly string[];
  readonly onPickSuggestion?: (slug: string) => void;
  readonly error?: string | null;
};

const DOT: Record<Status, string> = {
  idle: 'bg-line',
  checking: 'bg-muted animate-live',
  invalid: 'bg-danger',
  free: 'bg-accent',
  live: 'bg-warn',
};

const LABEL: Record<Status, string> = {
  idle: '',
  checking: 'verificando',
  invalid: '3 a 25 caracteres: letras, números e hífen',
  free: 'disponível',
  live: 'alguém está transmitindo neste link agora',
};

/**
 * Campo único. O prefixo do domínio fica dentro do campo, não numa label
 * acima: o usuário está escolhendo o final de uma URL que ele já vê inteira.
 */
export function SlugPicker({
  value,
  onChange,
  status,
  suggestions = [],
  onPickSuggestion,
  error,
}: Props) {
  const message = error ?? LABEL[status];

  return (
    <div className="w-full max-w-md">
      <label htmlFor="slug" className="sr-only">
        Escolha o final do seu link
      </label>

      <div className="flex items-center gap-0 rounded-md border border-line bg-surface transition-colors focus-within:border-muted">
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
          aria-invalid={status === 'invalid' || Boolean(error)}
          className="tabular min-w-0 flex-1 bg-transparent py-3 pr-3 text-[15px] outline-none placeholder:text-line"
        />
        <span
          className={`mr-4 h-2 w-2 shrink-0 rounded-full ${DOT[status]}`}
          aria-hidden="true"
        />
      </div>

      <p
        id="slug-status"
        role="status"
        className={`mt-2 min-h-5 text-[13px] ${
          status === 'invalid' || error ? 'text-danger' : 'text-dim'
        }`}
      >
        {message}
      </p>

      {suggestions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {suggestions.map((slug) => (
            <button
              key={slug}
              type="button"
              onClick={() => onPickSuggestion?.(slug)}
              className="tabular rounded-sm border border-line px-2.5 py-1.5 text-[13px] text-dim transition-colors duration-150 hover:border-muted hover:text-text"
            >
              {slug}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
