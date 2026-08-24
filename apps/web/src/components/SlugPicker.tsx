import { IconCheck, IconWarning } from './Icon.js';

type Status = 'idle' | 'checking' | 'invalid' | 'free' | 'live';

type Props = {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly status: Status;
  readonly suggestions?: readonly string[];
  readonly onPickSuggestion?: (slug: string) => void;
  readonly error?: string | null;
  /**
   * `heroi` na tela inicial, onde este campo É o produto. Ver a nota de
   * tamanho abaixo.
   */
  readonly tamanho?: 'heroi' | 'padrao';
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
 *
 * # Por que ele fica GRANDE na tela inicial
 *
 * O produto entrega uma coisa: um link. O campo onde esse link é escrito era
 * 15px, o mesmo corpo do rótulo "Qualidade" ao lado — ou seja, o artefato e a
 * legenda de um controle secundário tinham o mesmo peso, e a tela ficava sem
 * centro. Em `heroi` ele passa a ser o maior texto da página, em
 * monoespaçada, com o prefixo `tela.gg/` deliberadamente menor: o que a pessoa
 * escolhe é o final, e é o final que ela vai ditar para os amigos.
 *
 * O tamanho vem de `clamp`, não de breakpoint: entre 360px e 1440px a largura
 * disponível varia continuamente e o campo tem 25 caracteres para caber. Um
 * degrau em `sm:` quebraria justo nas larguras entre dois degraus.
 */
export function SlugPicker({
  value,
  onChange,
  status,
  suggestions = [],
  onPickSuggestion,
  error,
  tamanho = 'padrao',
}: Props) {
  const problema = status === 'invalid' || Boolean(error);
  const mensagem = error ?? LABEL[status];
  const heroi = tamanho === 'heroi';

  return (
    <div className={heroi ? 'w-full' : 'w-full max-w-md'}>
      <label htmlFor="slug" className="sr-only">
        Escolha o final do seu link
      </label>

      {/*
        O recuo vertical mora no `input`, não nesta caixa.
        Com ele aqui, a área clicável do campo eram os 28px da linha de texto e
        o resto da caixa não fazia nada — medido a 360px, e reprova nos 44px de
        alvo de toque. `padding` dentro do próprio `input` faz a caixa inteira
        virar alvo, que é o que a pessoa vê e onde ela toca.
      */}
      {/*
        `data-vidro`: a abertura mede esta caixa no DOM vivo para desenhar o
        contorno do campo dentro do tubo. Atributo inerte em toda página que não
        seja a inicial — ver `react/use-abertura.ts`.
      */}
      <div
        data-vidro="contorno"
        className={[
          'flex items-baseline rounded-md border bg-void transition-colors duration-150',
          heroi ? 'px-4 sm:px-5' : '',
          problema ? 'border-danger' : 'border-edge focus-within:border-text',
        ].join(' ')}
      >
        <span
          className={[
            'tabular shrink-0 select-none text-muted',
            heroi
              ? 'text-[clamp(15px,2.6vw,21px)]'
              : 'py-3 pl-4 text-[15px]',
          ].join(' ')}
        >
          tela.gg/
        </span>
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
          className={[
            'tabular min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint',
            heroi
              ? 'py-3 text-[clamp(24px,4.6vw,38px)] leading-[1.15] tracking-[-0.02em] sm:py-3.5'
              : 'py-3 pr-4 text-[15px]',
          ].join(' ')}
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
