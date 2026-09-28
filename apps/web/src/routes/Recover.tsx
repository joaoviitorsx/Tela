import { useState } from 'react';
import { Aviso } from '../components/Aviso.js';
import { Botao } from '../components/Botao.js';
import { Cabecalho } from '../components/Cabecalho.js';
import { VidroCrt } from '../components/EfeitosTv.js';
import { PainelOsd } from '../components/PainelOsd.js';
import { identity } from '../container.js';
import { useCopia } from '../react/use-copia.js';

type Props = { readonly onBack: () => void };

/**
 * A página que torna o "sem cadastro" honesto.
 *
 * Não há senha nem e-mail — o token no localStorage É a conta. Limpar os dados
 * do navegador apaga o link. Esta página existe para o usuário exportar o
 * token antes que isso aconteça, e reimportar em outra máquina.
 *
 * # Por que são duas colunas
 *
 * Não é para "preencher a tela": são duas operações simétricas e opostas —
 * tirar daqui, colocar ali — e empilhá-las numa coluna fazia a segunda parecer
 * continuação da primeira. Lado a lado, a simetria é a explicação: o que você
 * copia à esquerda é o que você cola à direita, em outro navegador. Abaixo de
 * `lg` elas voltam a empilhar, na ordem em que se usam.
 *
 * O aviso subiu para o topo: quem chega aqui precisa entender o risco ANTES de
 * decidir se copia, e um parágrafo embaixo de uma caixa de texto é lido depois
 * de tudo, quando é lido.
 */
export function Recover({ onBack }: Props) {
  const [token, setToken] = useState(() => identity.exportToken());
  const [input, setInput] = useState('');
  const [imported, setImported] = useState(false);
  const copia = useCopia(1_500);

  const slugAtual = identity.savedSlug();

  return (
    <div className="flex min-h-dvh flex-col bg-void">
      <VidroCrt />
      <Cabecalho marcaHref="/">
        <Botao onClick={onBack}>VOLTAR PARA O INÍCIO</Botao>
      </Cabecalho>

      <main className="mx-auto flex w-full max-w-[980px] flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex flex-col gap-2.5">
          <h1 className="rotulo m-0 text-[12px]">O QUE É ESTE CÓDIGO</h1>
          <p className="m-0 max-w-[70ch] text-[13px] leading-relaxed text-text [text-wrap:pretty]">
            Ele é a única coisa que prova que o seu link é seu. Não há e-mail para redefinir, nem
            senha para lembrar: guarde-o onde você guardaria uma senha. Limpar os dados deste
            navegador sem ter guardado o código significa perder o link para sempre.
          </p>
        </div>

        <div className="grid items-stretch gap-5 lg:grid-cols-2">
          <PainelOsd titulo="MENU ▸ GUARDAR ESTE NAVEGADOR">
            <div className="flex flex-1 flex-col justify-center gap-4 p-4 sm:p-5">
              <code className="block break-all border-2 border-edge bg-deep p-3 text-[13px] leading-relaxed text-accent-hi">
                {token}
              </code>
              <Botao bloco onClick={() => copia.copiar(token)}>
                {copia.copiado ? 'CÓDIGO COPIADO' : 'COPIAR CÓDIGO'}
              </Botao>
            </div>
          </PainelOsd>

          <PainelOsd titulo="MENU ▸ RESTAURAR EM OUTRO NAVEGADOR">
            <div className="flex flex-col gap-4 p-4 sm:p-5">
              <label htmlFor="token" className="text-[12px] leading-relaxed text-muted">
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
                <Aviso tom="alerta">
                  Este navegador transmite hoje como{' '}
                  <span className="text-accent-hi">tela.gg/{slugAtual}</span>. Restaurar outro código
                  troca essa identidade, e sem o código dela você não recupera esse link.
                </Aviso>
              )}

              <input
                id="token"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="cole aqui"
                spellCheck={false}
                autoComplete="off"
                className="min-h-12 border-2 border-edge bg-deep px-3 text-[13px] text-text outline-none placeholder:text-faint focus:border-accent"
              />
              <Botao
                bloco
                disabled={input.trim().length < 43}
                onClick={() => {
                  identity.importToken(input);
                  setToken(identity.exportToken());
                  setInput('');
                  setImported(true);
                }}
              >
                RESTAURAR
              </Botao>
              {imported && (
                <p role="status" className="m-0 text-[12px] text-ok">
                  Pronto. Volte e digite o slug do link para transmitir.
                </p>
              )}
            </div>
          </PainelOsd>
        </div>
      </main>
    </div>
  );
}
