import { useState } from 'react';
import { BigButton } from '../components/BigButton.js';
import { IconCheck, IconCopy, IconWarning } from '../components/Icon.js';
import { Masthead } from '../components/Masthead.js';
import { Panel, PanelSection } from '../components/Panel.js';

import { identity } from '../container.js';

type Props = { readonly onBack: () => void };

/**
 * A página que torna o "sem cadastro" honesto.
 *
 * Não há senha nem e-mail — o token no localStorage É a conta. Limpar os dados
 * do navegador apaga o link. Esta página existe para o usuário exportar o
 * token antes que isso aconteça, e reimportar em outra máquina.
 *
 * # Por que virou duas colunas
 *
 * Não é para "preencher a tela": são duas operações simétricas e opostas —
 * tirar daqui, colocar ali — e empilhá-las numa coluna de 448px fazia a
 * segunda parecer continuação da primeira. Lado a lado, a simetria é a
 * explicação: o que você copia à esquerda é o que você cola à direita, em
 * outro navegador. Abaixo de `lg` elas voltam a empilhar, na ordem em que se
 * usam.
 *
 * O aviso subiu para o topo em vez de ficar como legenda do código: quem chega
 * aqui precisa entender o risco ANTES de decidir se copia, e um parágrafo
 * embaixo de uma caixa de texto é lido depois de tudo, quando é lido.
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

  const slugAtual = identity.savedSlug();

  return (
    <div className="flex min-h-dvh flex-col justify-center px-4 py-4 sm:px-6 sm:py-8">
      <Panel className="mx-auto w-full max-w-[920px]">
        <Masthead>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-h-11 items-center rounded-sm px-2 text-[13px] text-muted underline decoration-line underline-offset-4 transition-colors duration-150 hover:text-text hover:decoration-text"
          >
            voltar para o início
          </button>
        </Masthead>

        <div className="border-b border-line bg-surface px-4 py-5 sm:px-6">
          <h1 className="serigrafia mb-2">o que é este código</h1>
          <p className="max-w-[70ch] text-[13.5px] leading-relaxed text-text">
            Ele é a única coisa que prova que o seu link é seu. Não há e-mail para redefinir,
            nem senha para lembrar — guarde-o onde você guardaria uma senha. Limpar os dados
            deste navegador sem ter guardado o código significa perder o link para sempre.
          </p>
        </div>

        <div className="flex flex-col lg:grid lg:grid-cols-2 lg:items-stretch">
          {/*
            Centrado porque a coluna da direita é mais alta (ela carrega o
            aviso de identidade). Sem isso, o "copiar código" ficava pendurado
            no topo com um vazio de 150px embaixo.
          */}
          <PanelSection
            rotulo="guardar este navegador"
            className="flex flex-col justify-center py-6"
          >
            <div className="flex flex-col gap-4">
              <code className="tabular block break-all rounded-md border border-edge bg-void p-3 text-[13px] leading-relaxed">
                {token}
              </code>

              <BigButton
                onClick={copy}
                tone="ghost"
                bloco
                icon={copied ? <IconCheck className="h-4 w-4 text-text" /> : <IconCopy />}
              >
                {copied ? 'copiado' : 'copiar código'}
              </BigButton>
            </div>
          </PanelSection>

          <PanelSection
            rotulo="restaurar em outro navegador"
            className="border-t border-line py-6 lg:border-l lg:border-t-0"
          >
            <div className="flex flex-col gap-4">
              <label htmlFor="token" className="text-[13px] leading-relaxed text-muted">
                Cole o código salvo. Ele substitui a identidade atual deste navegador.
              </label>

              {/*
                Restaurar é DESTRUTIVO e não avisava o que ia destruir. O slug
                lembrado já estava no `localStorage` e já era lido pela tela
                inicial; dizer aqui qual link está prestes a ser trocado não
                acrescenta dado nenhum ao produto — só mostra, no momento da
                decisão, o que a decisão custa.
              */}
              {slugAtual !== null && slugAtual !== '' && (
                <p className="flex items-start gap-1.5 rounded-md border border-line bg-surface p-3 text-[12.5px] leading-relaxed text-warn">
                  <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Este navegador transmite hoje como{' '}
                    <span className="tabular text-text">tela.gg/{slugAtual}</span>. Restaurar
                    outro código troca essa identidade, e sem o código dela você não recupera
                    esse link.
                  </span>
                </p>
              )}
              <input
                id="token"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="cole aqui"
                spellCheck={false}
                className="tabular min-h-12 rounded-md border border-edge bg-void px-3 text-[13px] outline-none transition-colors focus:border-text placeholder:text-faint"
              />
              <BigButton
                onClick={() => {
                  identity.importToken(input);
                  setToken(identity.exportToken());
                  setInput('');
                  setImported(true);
                }}
                tone="ghost"
                bloco
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
            </div>
          </PanelSection>
        </div>
      </Panel>
    </div>
  );
}
