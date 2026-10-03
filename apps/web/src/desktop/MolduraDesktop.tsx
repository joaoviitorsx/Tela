import { type ReactNode, useRef, useState } from 'react';
import { Aviso } from '../components/Aviso.js';
import { DialogoAssistir } from '../components/DialogoAssistir.js';
import { DialogoConfirmar } from '../components/DialogoConfirmar.js';
import type { FonteDeVisibilidade } from '../react/use-aba-visivel.js';
import { useDiagnosticoAberto } from '../react/painel-diagnostico.js';
import { useDialogo } from '../react/use-dialogo.js';
import { BarraDaJanela } from './BarraDaJanela.js';
import { avisoNoTrilho } from './atualizacao.js';
import { DialogoAjustes } from './DialogoAjustes.js';
import { DialogoFechar } from './DialogoFechar.js';
import { ModoCompacto } from './ModoCompacto.js';
import { PainelNoAr } from './PainelNoAr.js';
import type { ModoDaJanelaStore } from './modo-da-janela.js';
import type { PonteDesktop } from './ponte.js';
import { type PonteDaBarra, useBarraDaJanela } from './use-barra-da-janela.js';
import { type SessaoAoVivo, sessaoAoVivo } from './sessao-ao-vivo.js';
import { TrilhoDesktop } from './TrilhoDesktop.js';
import { useAjustes } from './use-ajustes.js';
import { type PonteDaAtualizacao, useAtualizacao } from './use-atualizacao.js';
import { useAssistir } from './use-assistir.js';
import { useCanalPorLink } from './use-canal-por-link.js';
import { DESTINO, itemAtivo, useNavegacaoDesktop } from './use-navegacao-desktop.js';
import { type PonteDoSegundoPlano, useSegundoPlano } from './use-segundo-plano.js';

type PonteDaMoldura = Pick<PonteDesktop, 'aoAbrirCanal'> &
  PonteDoSegundoPlano &
  Pick<PonteDesktop, 'ajustes' | 'salvarAjustes' | 'abrirNoNavegador' | 'versao'> &
  PonteDaAtualizacao &
  Partial<PonteDaBarra>;

type Props = {
  readonly children: ReactNode;
  /** O que fica por cima de tudo: o seletor de fontes (D2). Opcional, porque em dev no navegador não há ponte. */
  readonly sobreposicao?: ReactNode;
  /** A ponte do preload: sem ela (dev no navegador) não chega `tela://` nem há bandeja. */
  readonly ponte?: PonteDaMoldura;
  /** Onde a moldura enxerga a transmissão (D4). Padrão: a do container do app. */
  readonly sessao?: SessaoAoVivo;
  readonly modo?: ModoDaJanelaStore;
  readonly visibilidade?: FonteDeVisibilidade;
  /** O som que confirma ocultar/mostrar pelo atalho (`audioCue.privacidade`). */
  readonly somDeOculto?: (oculto: boolean) => void;
  /** Ver `useSegundoPlano`: o que tem de terminar antes de o app sair. */
  readonly antesDeSair?: () => Promise<void>;
};

/**
 * A moldura do app em volta das telas do site: trilho à esquerda, a tela à
 * direita, rolando sozinha, e — ao vivo — o painel NO AR no pé. As rotas de
 * tela inteira medem `var(--altura-da-tela, 100dvh)`; aqui a variável é a
 * altura da coluna.
 *
 * Também é daqui que entram os canais (D8): o painel ASSISTIR e o link
 * `tela://assistir/<canal>` terminam na mesma navegação para `/<canal>`.
 *
 * # Compacto (D4)
 *
 * No modo compacto a árvore das rotas CONTINUA MONTADA, só escondida
 * (`hidden`): a `BroadcastSession` vive na rota `/transmitir`, e desmontá-la
 * derrubaria a transmissão. Esconder não é desmontar.
 */
export function MolduraDesktop({
  children,
  sobreposicao,
  ponte,
  sessao = sessaoAoVivo,
  modo,
  visibilidade,
  somDeOculto,
  antesDeSair,
}: Props) {
  const { caminho, travado, irPara } = useNavegacaoDesktop();
  const assistir = useAssistir(irPara);
  const porLink = useCanalPorLink(ponte, irPara);
  const sp = useSegundoPlano({
    sessao,
    ponte,
    ...(modo === undefined ? {} : { modo }),
    ...(visibilidade === undefined ? {} : { visibilidade }),
    ...(somDeOculto === undefined ? {} : { somDeOculto }),
    ...(antesDeSair === undefined ? {} : { antesDeSair }),
  });
  const ajustes = useAjustes(ponte);
  const atualizacao = useAtualizacao(ponte);
  const aviso = atualizacao.estado === null ? null : avisoNoTrilho(atualizacao.estado);
  // O botão do cabeçalho do site mora no trilho (D-04); quem abre o painel é outro componente.
  const diagnostico = useDiagnosticoAberto();

  const compactoNoAr = sp.compacto && sp.noAr;

  // A barra própria (§11): só no app, no Windows e no Linux; some em tela cheia.
  const barra = useBarraDaJanela(
    ponte?.plataforma !== undefined && ponte.janela !== undefined ? { plataforma: ponte.plataforma, janela: ponte.janela } : undefined,
  );
  const comBarra = barra !== null && !barra.estado.telaCheia;
  // No Linux o app não tem moldura do sistema: a borda de `edge` é a da janela.
  const comBorda = comBarra && barra.plataforma === 'linux' && !barra.estado.maximizada;

  // ENCERRAR do painel: a confirmação do Tela, a mesma da rota. No compacto
  // a pergunta vem inline (a janela é pequena demais para um diálogo).
  const seguroRef = useRef<HTMLButtonElement>(null);
  const dialogoEncerrar = useDialogo(sp.encerrar.confirmando && !compactoNoAr, sp.encerrar.cancelar, seguroRef);

  const continuarRef = useRef<HTMLButtonElement>(null);
  const dialogoFechar = useDialogo(sp.fechar.perguntando, () => sp.fechar.responder('cancelar'), continuarRef);

  const [ajustesAbertos, setAjustesAbertos] = useState(false);
  const fecharRef = useRef<HTMLButtonElement>(null);
  const dialogoAjustes = useDialogo(ajustesAbertos, () => setAjustesAbertos(false), fecharRef);

  const abrirAjustes = () => {
    ajustes.recarregar();
    setAjustesAbertos(true);
  };

  return (
    <div
      className={`flex h-dvh w-full flex-col overflow-hidden bg-void ${comBorda ? 'border-2 border-edge' : ''}`}
    >
      {comBarra && (
        <BarraDaJanela
          plataforma={barra.plataforma}
          link={sp.noAr && sp.painel.link !== '' ? sp.painel.link : null}
          ativa={barra.estado.focada}
          maximizada={barra.estado.maximizada}
          compacto={compactoNoAr}
          aoMinimizar={barra.minimizar}
          aoAlternarMaximizar={barra.alternarMaximizar}
          aoFechar={barra.fechar}
        />
      )}
      {compactoNoAr && (
        <ModoCompacto
          link={sp.painel.link}
          semLink={comBarra}
          tempo={sp.painel.tempo}
          assistindo={sp.painel.assistindo}
          capacidade={sp.painel.capacidade}
          copiado={sp.copiado}
          aoCopiar={sp.copiarLink}
          confirmando={sp.encerrar.confirmando}
          textoConfirmar={sp.encerrar.texto}
          aoEncerrar={sp.encerrar.pedir}
          aoConfirmar={sp.encerrar.confirmar}
          aoCancelar={sp.encerrar.cancelar}
          aoExpandir={sp.expandir}
        />
      )}
      <div className={compactoNoAr ? 'hidden' : 'flex min-h-0 flex-1'}>
        <TrilhoDesktop
          ativo={itemAtivo(caminho)}
          travado={travado}
          aoEscolher={(item) => (item === 'assistir' ? assistir.abrir() : irPara(DESTINO[item]))}
          aoDiagnostico={diagnostico.abrir}
          {...(ponte === undefined ? {} : { aoAjustes: abrirAjustes })}
          {...(aviso === null
            ? {}
            : {
                atualizar: {
                  titulo: aviso.titulo,
                  aoClicar: aviso.acao === 'reiniciar' ? atualizacao.reiniciar : abrirAjustes,
                },
              })}
        />
        {/*
          `--altura-da-tela`: as rotas de tela inteira (espectador, console)
          medem `100dvh` na web; aqui a coluna é menor que a janela (barra de
          título, painel NO AR), e é ela a altura delas.
        */}
        <div className="min-w-0 flex-1 overflow-y-auto [--altura-da-tela:100%]">{children}</div>
      </div>
      {sp.noAr && !compactoNoAr && (
        <PainelNoAr
          tempo={sp.painel.tempo}
          assistindo={sp.painel.assistindo}
          capacidade={sp.painel.capacidade}
          rota={sp.painel.rota}
          encoder={sp.painel.encoder}
          aoCompactar={sp.compactar}
          aoEncerrar={sp.encerrar.pedir}
          oculto={sp.painel.oculto}
          atalhoOculto={sp.painel.atalhoOculto}
          aoAlternarOculto={sp.painel.alternarOculto}
        />
      )}
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
      <DialogoConfirmar
        titulo="ENCERRAR A TRANSMISSÃO?"
        dialogRef={dialogoEncerrar.ref}
        aoClicarNoFundo={dialogoEncerrar.aoClicar}
        rotuloSeguro="CONTINUAR NO AR"
        seguroRef={seguroRef}
        aoSeguro={sp.encerrar.cancelar}
        rotuloAcao="ENCERRAR"
        aoAcao={sp.encerrar.confirmar}
      >
        {sp.encerrar.texto}
      </DialogoConfirmar>
      <DialogoFechar
        dialogRef={dialogoFechar.ref}
        aoClicarNoFundo={dialogoFechar.aoClicar}
        bandeja={ajustes.bandeja}
        lembrar={sp.fechar.lembrar}
        aoMudarLembrar={sp.fechar.mudarLembrar}
        continuarRef={continuarRef}
        aoContinuar={() => sp.fechar.responder('segundo-plano')}
        aoEncerrar={() => sp.fechar.responder('encerrar')}
      />
      <DialogoAjustes
        dialogRef={dialogoAjustes.ref}
        aoClicarNoFundo={dialogoAjustes.aoClicar}
        ajustes={ajustes.ajustes}
        bandeja={ajustes.bandeja}
        autostartFalhou={ajustes.autostartFalhou}
        aoMudar={ajustes.mudar}
        {...(ponte === undefined
          ? {}
          : {
              atualizacao: {
                versao: ponte.versao,
                estado: atualizacao.estado,
                aoVerificar: atualizacao.verificar,
                aoReiniciar: atualizacao.reiniciar,
                aoAbrirPagina: (url) => ponte.abrirNoNavegador(url),
              },
            })}
        fecharRef={fecharRef}
        aoFechar={() => setAjustesAbertos(false)}
      />
      {(porLink.aviso !== null || sp.aviso !== null) && (
        <div className="fixed bottom-4 left-[120px] max-[759px]:left-[72px] z-50 flex max-w-[420px] flex-col gap-2">
          {[
            { chave: 'link', texto: porLink.aviso, dispensar: porLink.dispensar },
            { chave: 'energia', texto: sp.aviso, dispensar: sp.dispensarAviso },
          ].map(
            (a) =>
              a.texto !== null && (
                <Aviso key={a.chave} tom="alerta" anuncia>
                  <span className="flex items-start gap-3">
                    <span>{a.texto}</span>
                    <button
                      type="button"
                      onClick={a.dispensar}
                      aria-label="Dispensar aviso"
                      className="font-[family-name:var(--font-pixel)] text-accent hover:text-accent-hi"
                    >
                      ×
                    </button>
                  </span>
                </Aviso>
              ),
          )}
        </div>
      )}
    </div>
  );
}
