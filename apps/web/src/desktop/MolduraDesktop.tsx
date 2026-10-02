import type { ReactNode } from 'react';
import { Aviso } from '../components/Aviso.js';
import { DialogoAssistir } from '../components/DialogoAssistir.js';
import type { PonteDesktop } from './ponte.js';
import { TrilhoDesktop } from './TrilhoDesktop.js';
import { useAssistir } from './use-assistir.js';
import { useCanalPorLink } from './use-canal-por-link.js';
import { DESTINO, itemAtivo, useNavegacaoDesktop } from './use-navegacao-desktop.js';

type Props = {
  readonly children: ReactNode;
  /** O que fica por cima de tudo: o seletor de fontes (D2). Opcional, porque em dev no navegador não há ponte. */
  readonly sobreposicao?: ReactNode;
  /** A ponte do preload: sem ela (dev no navegador) não chega `tela://`. */
  readonly ponte?: Pick<PonteDesktop, 'aoAbrirCanal'>;
};

/**
 * A moldura do app em volta das telas do site: trilho à esquerda, a tela à
 * direita, rolando sozinha. As rotas continuam `min-h-dvh`; aqui elas são
 * a altura da coluna, e a coluna é a janela.
 *
 * Também é daqui que entram os canais (D8): o painel ASSISTIR e o link
 * `tela://assistir/<canal>` terminam na mesma navegação para `/<canal>`.
 */
export function MolduraDesktop({ children, sobreposicao, ponte }: Props) {
  const { caminho, travado, irPara } = useNavegacaoDesktop();
  const assistir = useAssistir(irPara);
  const porLink = useCanalPorLink(ponte, irPara);
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-void">
      <TrilhoDesktop
        ativo={itemAtivo(caminho)}
        travado={travado}
        aoEscolher={(item) => (item === 'assistir' ? assistir.abrir() : irPara(DESTINO[item]))}
      />
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
      {sobreposicao}
      <DialogoAssistir
        dialogRef={assistir.dialogo.ref}
        aoClicarNoFundo={assistir.dialogo.aoClicar}
        inputRef={assistir.inputRef}
        valor={assistir.valor}
        aoMudar={assistir.mudar}
        invalido={assistir.invalido}
        aoEnviar={assistir.enviar}
        aoCancelar={assistir.fechar}
      />
      {porLink.aviso !== null && (
        <div className="fixed bottom-4 left-[92px] z-50 max-w-[420px]">
          <Aviso tom="alerta" anuncia>
            <span className="flex items-start gap-3">
              <span>{porLink.aviso}</span>
              <button
                type="button"
                onClick={porLink.dispensar}
                aria-label="Dispensar aviso"
                className="font-[family-name:var(--font-pixel)] text-accent hover:text-accent-hi"
              >
                ×
              </button>
            </span>
          </Aviso>
        </div>
      )}
    </div>
  );
}
