import { useState } from 'react';
import { BigButton } from '../components/BigButton.js';
import { IconCheck, IconCopy } from '../components/Icon.js';
import { identity } from '../container.js';

type Props = { readonly onBack: () => void };

/**
 * A página que torna o "sem cadastro" honesto.
 *
 * Não há senha nem e-mail — o token no localStorage É a conta. Limpar os dados
 * do navegador apaga o link. Esta página existe para o usuário exportar o
 * token antes que isso aconteça, e reimportar em outra máquina.
 */
export function Recover({ onBack }: Props) {
  const [token, setToken] = useState(() => identity.exportToken());
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [imported, setImported] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(token).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <section className="flex flex-col gap-3">
        <h1 className="text-[17px] font-semibold">Seu código de recuperação</h1>
        <p className="text-[13px] text-muted">
          Guarde isto onde você guardaria uma senha. É a única coisa que prova que o link é seu — não
          há e-mail para redefinir. Limpar os dados deste navegador sem guardar o código significa
          perder o link.
        </p>

        <code className="tabular block break-all rounded-md border border-edge bg-surface p-3 text-[13px]">
          {token}
        </code>

        <BigButton
          onClick={copy}
          tone="ghost"
          icon={copied ? <IconCheck className="h-4 w-4 text-text" /> : <IconCopy />}
        >
          {copied ? 'copiado' : 'copiar código'}
        </BigButton>
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-8">
        <h2 className="text-[17px] font-semibold">Restaurar em outro navegador</h2>
        <label htmlFor="token" className="text-[13px] text-muted">
          Cole o código salvo. Ele substitui a identidade atual deste navegador.
        </label>
        <input
          id="token"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="cole aqui"
          spellCheck={false}
          className="tabular rounded-md border border-edge bg-surface px-3 py-3 text-[13px] outline-none transition-colors focus:border-text placeholder:text-faint"
        />
        <BigButton
          onClick={() => {
            identity.importToken(input);
            setToken(identity.exportToken());
            setInput('');
            setImported(true);
          }}
          tone="ghost"
          disabled={input.trim().length < 43}
        >
          restaurar
        </BigButton>
        {imported && (
          <p role="status" className="flex items-center gap-1.5 text-[13px] text-text">
            <IconCheck className="h-3.5 w-3.5 shrink-0" />
            Pronto. Volte e digite o slug do link para transmitir.
          </p>
        )}
      </section>

      <button
        type="button"
        onClick={onBack}
        className="self-start text-[13px] text-muted transition-colors duration-150 hover:text-text"
      >
        voltar
      </button>
    </main>
  );
}
