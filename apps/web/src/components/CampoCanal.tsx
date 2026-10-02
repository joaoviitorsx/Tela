import { IconOk } from './Icon.js';

type Props = {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onEnter: () => void;
  readonly status: 'idle' | 'free' | 'invalid';
  /** A frase do erro, quando há. Sem ela vale o texto padrão do status. */
  readonly error?: string | null;
  /** Acima do campo, só quando o nome veio da última visita (H-03). */
  readonly rotulo?: string | null;
};

const MENSAGEM = {
  idle: 'Use de 3 a 25 caracteres: letras, números e hífen.',
  free: 'Nome válido. Se outra pessoa estiver no ar com ele, você saberá ao ir ao ar.',
  invalid: 'Esse nome não serve. Use de 3 a 25 caracteres: letras, números e hífen.',
} as const;

/**
 * O endereço do canal: `tela.gg/` e o nome em numeral grande, fósforo âmbar
 * sobre o fundo mais escuro da tela — o campo É o pequeno monitor onde se lê o
 * link que os amigos vão abrir.
 *
 * # Acessibilidade
 *
 * O `<label>` é visível ao leitor de tela e atrelado ao `#slug`. A mensagem de
 * estado é `role="status"` e o `aria-describedby` do campo: a frase inteira,
 * não só a cor — o "válido" tem ícone, o "inválido" tem "!" e texto.
 *
 * `data-vidro`: a abertura mede o campo no DOM vivo para desenhar o contorno
 * dele no tubo (`react/use-abertura.ts`). Atributo inerte fora da tela inicial.
 */
export function CampoCanal({ value, onChange, onEnter, status, error, rotulo = null }: Props) {
  const invalido = status === 'invalid';
  const mensagem = invalido && error ? error : MENSAGEM[status];

  return (
    <div className="flex w-full flex-col gap-2.5">
      {rotulo !== null && (
        <span data-vidro="texto" className="rotulo">
          {rotulo}
        </span>
      )}
      <label htmlFor="slug" className="sr-only">
        Nome do seu canal: o final do link
      </label>
      <div
        data-vidro="contorno"
        className={[
          'flex flex-wrap items-baseline gap-x-1 border-2 bg-deep px-5 py-4 shadow-[inset_0_0_30px_rgb(242_169_59_/_0.06),0_0_0_2px_#000]',
          /*
            Inválido mantém a borda de erro mesmo com foco (B-04): o foco vira o
            anel externo, não a cor da borda, senão o campo errado ficava âmbar.
          */
          'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent-hi',
          invalido ? 'border-danger-edge' : 'border-edge focus-within:border-accent',
        ].join(' ')}
      >
        <span className="numeral select-none text-[clamp(26px,4vw,44px)] text-dim">tela.gg/</span>
        <input
          id="slug"
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEnter();
          }}
          placeholder="seunome"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={25}
          aria-describedby="slug-status"
          aria-invalid={invalido}
          className="numeral min-h-11 min-w-0 flex-1 basis-40 border-0 bg-transparent p-0 text-[clamp(38px,6vw,72px)] text-accent-hi outline-none [text-shadow:0_0_18px_rgb(242_169_59_/_0.45)] placeholder:text-faint placeholder:[text-shadow:none]"
        />
      </div>

      <p
        id="slug-status"
        role="status"
        className={[
          'flex min-h-5 items-start gap-2 text-[12px] leading-snug',
          invalido ? 'text-danger' : status === 'free' ? 'text-ok' : 'text-muted',
        ].join(' ')}
      >
        {invalido && <span aria-hidden="true" className="font-[family-name:var(--font-pixel)]">!</span>}
        {status === 'free' && <IconOk className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <span>{mensagem}</span>
      </p>
    </div>
  );
}
