import { PRESETS, PRESET_ORDER, type PresetId } from '@tela/shared';
import { useCallback, useMemo, useState } from 'react';
import { AudioSourcePicker } from '../components/AudioSourcePicker.js';
import { BarraAjuda } from '../components/BarraAjuda.js';
import { Botao, LinkTecla } from '../components/Botao.js';
import { BotoesDoCabecalho } from '../components/BotoesDoCabecalho.js';
import { Cabecalho } from '../components/Cabecalho.js';
import { CampoCanal } from '../components/CampoCanal.js';
import { CanalFlash, EstaticaTroca, VidroCrt } from '../components/EfeitosTv.js';
import { Medidor } from '../components/Medidor.js';
import { MenuOsd, type LinhaMenu } from '../components/MenuOsd.js';
import { PainelOsd } from '../components/PainelOsd.js';
import { Passos, type Passo } from '../components/Passos.js';
import { SeletorDeResolucao, type OpcaoDeResolucao } from '../components/SeletorDeResolucao.js';
import { Vitrine } from '../components/Vitrine.js';
import {
  audioCue,
  identity,
  platform,
  preferences,
  presetSustentavel,
  volumeTransmissaoPreference,
} from '../container.js';
import { isPresetId } from '../core/media/presets.js';
import { useAudioSources } from '../react/use-audio-sources.js';
import { useMenuOsd } from '../react/use-menu-osd.js';
import { useSlugCheck } from '../react/use-slug-check.js';
import { useTrocaDeCanal } from '../react/use-troca-de-canal.js';
import { useVitrine } from '../react/use-vitrine.js';
import { useVolumeTransmissao } from '../react/use-volume-transmissao.js';
import { ModalApp } from './ModalApp.js';
import { ModalDiagnosticoPreAr } from './ModalDiagnosticoPreAr.js';

type Props = {
  readonly onStart: (slug: string, presetId: PresetId, audioDeviceId: string | null) => void;
};

type NumeroDoPasso = 1 | 2 | 3;

const NOMES = { 1: 'CANAL', 2: 'TELA OU JOGO', 3: 'ÁUDIO' } as const;

/** "576p60 econômico" cabe mal numa linha de menu. */
const rotuloDoPreset = (id: PresetId): string => PRESETS[id].label.replace(' econômico', ' eco');

const IDS_POR_PASSO: Record<NumeroDoPasso, readonly string[]> = {
  1: [],
  // O seletor de resolução usa o mesmo menu: ←→ troca, Enter continua.
  2: ['resolucao'],
  3: ['volume'],
};

/**
 * A chapa frontal do produto e os três passos que ficam antes do ar.
 *
 * # O fluxo
 *
 * `01 canal → 02 tela ou jogo → 03 áudio → 04 no ar`, os quatro passos do
 * protótipo, em sequência: TRANSMITIR (ou Enter no campo) leva ao 02, o 02
 * ao 03, e só o IR AO AR E GERAR LINK do 03 abre o seletor de tela. O canal
 * já vem com o último nome usado. (Houve um atalho direto ao ar no passo 01;
 * saiu a pedido do dono do produto: o fluxo passa pelos três.)
 *
 * O passo 04 é a rota `/transmitir` (`Broadcast`): é lá que o navegador abre o
 * seletor de tela, que exige o gesto do clique. Por isso ele aparece na trilha
 * como destino e não como lugar onde se possa estar daqui.
 *
 * # O que NÃO existe aqui
 *
 * Uma lista de janelas ou tipos de captura (quem escolhe é o seletor do navegador), uma escolha
 * "sem áudio" no Windows (a caixa do Chrome decide), uma linha de 30 fps (só
 * existe dentro do modo NITIDEZ, que se liga ao vivo — R5) e a prioridade
 * fluidez/nitidez no passo 02, porque a sessão só a aceita depois de ao vivo.
 *
 * # Continua sem reserva de slug
 *
 * Sem API HTTP, quem decide se o nome está livre é o servidor de sinalização, no
 * `host`. O usuário descobre ao apertar TRANSMITIR. Em troca, digitar não faz uma
 * requisição por tecla e não existe endpoint que sirva para varrer quem existe.
 */
export function Home({ onStart }: Props) {
  const [slug, setSlug] = useState(() => identity.savedSlug() ?? '');
  const [presetId, setPresetId] = useState<PresetId>(() => {
    const saved = preferences.read();
    return isPresetId(saved) ? saved : 'p1080p60';
  });
  const [audioDeviceId, setAudioDeviceId] = useState<string | null>(null);
  const [modal, setModal] = useState<'diagnostico' | 'app' | null>(null);
  /** As instruções de áudio do sistema ficam fechadas até alguém pedir. */
  const [comoAudio, setComoAudio] = useState(false);
  const fecharModal = useCallback(() => setModal(null), []);

  const check = useSlugCheck(slug);
  const troca = useTrocaDeCanal<NumeroDoPasso>(1);
  const som = useVolumeTransmissao(volumeTransmissaoPreference);
  const fontes = useAudioSources();
  const os = platform.osName();
  const modoAudio = platform.systemAudio();
  /*
    O que o link da última transmissão sustentou — lido uma vez, porque é
    preferência gravada e não muda enquanto a página está aberta.
  */
  const sustentavel = useMemo(() => presetSustentavel(), []);

  const valido = check.status === 'ok';
  const passo = troca.passo;

  const escolherPreset = useCallback((id: PresetId) => {
    setPresetId(id);
    preferences.write(id);
  }, []);

  const iniciar = useCallback(() => {
    const wanted = slug.trim().toLowerCase();
    if (!valido) return;
    // §10 da coreografia: a abertura é muda, e o chiado entra como recompensa
    // do primeiro gesto. Este é o gesto.
    audioCue.estouro();
    identity.rememberSlug(wanted);
    onStart(wanted, presetId, audioDeviceId);
  }, [slug, valido, presetId, audioDeviceId, onStart]);

  /**
   * O que o tubo da vitrine mostra: o MESMO dado do campo, traduzido para o
   * vocabulário do aparelho. Não há segunda fonte de verdade — se o campo mudar
   * de regra, o tubo muda junto, porque ele lê daqui.
   */
  const noTubo = useMemo(
    () => ({
      slug: slug.trim().toLowerCase(),
      status:
        slug.trim() === ''
          ? ('vazio' as const)
          : check.status === 'ok'
            ? ('livre' as const)
            : check.status === 'invalid'
              ? ('invalido' as const)
              : ('verificando' as const),
    }),
    [slug, check.status],
  );
  const focaOCampo = useCallback(() => document.getElementById('slug')?.focus(), []);
  const vitrine = useVitrine(noTubo, focaOCampo, passo === 1);

  /* ─────────────── o menu do passo atual ─────────────── */

  const indice = PRESET_ORDER.indexOf(presetId);
  const preset = PRESETS[presetId];
  const limite = sustentavel === null ? -1 : PRESET_ORDER.indexOf(sustentavel);

  const ajudaResolucao = [
    `${preset.width}×${preset.height} a ${preset.main.maxFramerate} quadros. ~${(preset.main.maxBitrate / 1_000_000).toFixed(1).replace('.', ',')} Mbps de subida por espectador.`,
    sustentavel !== null ? `Sua última transmissão sustentou ${PRESETS[sustentavel].label}.` : '',
    limite > 0 && indice < limite
      ? 'Acima disso a imagem desce sozinha para o que couber: o rótulo muda, a nitidez não melhora.'
      : '',
  ]
    .filter((t) => t !== '')
    .join(' ');

  const opcoesDeResolucao = useMemo(
    (): readonly OpcaoDeResolucao[] =>
      PRESET_ORDER.map((id) => ({
        id,
        rotulo: rotuloDoPreset(id),
        largura: PRESETS[id].width,
        altura: PRESETS[id].height,
        fps: PRESETS[id].main.maxFramerate,
        mbps: (PRESETS[id].main.maxBitrate / 1_000_000).toFixed(1).replace('.', ','),
      })),
    [],
  );

  const linhas: readonly LinhaMenu[] =
    passo === 3
        ? [
            {
              id: 'volume',
              tipo: 'barra',
              rotulo: 'VOLUME QUE OS AMIGOS OUVEM',
              valor: Math.round(som.volume * 100),
              ajuda: 'Só muda o que chega para eles. O seu som continua igual.',
            },
          ]
        : [];

  const ajustar = useCallback(
    (id: string, direcao: -1 | 1) => {
      if (id === 'resolucao') {
        // Sem dar a volta: de 1080p, "←" não pode cair em 360p por acidente.
        const proximo = PRESET_ORDER[Math.min(PRESET_ORDER.length - 1, Math.max(0, indice + direcao))];
        if (proximo !== undefined) escolherPreset(proximo);
      } else if (id === 'volume') {
        som.definir(Math.round((som.volume + direcao * 0.1) * 10) / 10);
      }
    },
    [indice, escolherPreset, som],
  );

  const irParaPasso = useCallback(
    (proximo: NumeroDoPasso) => {
      if (proximo > 1 && !valido) return;
      troca.irPara(proximo);
    },
    [valido, troca],
  );

  const confirmar = useCallback(() => {
    if (passo === 2) irParaPasso(3);
    else if (passo === 3) iniciar();
  }, [passo, irParaPasso, iniciar]);

  const menu = useMenuOsd({
    ids: IDS_POR_PASSO[passo],
    aoAjustar: ajustar,
    aoConfirmar: confirmar,
    global: passo !== 1 && !troca.estatica,
  });

  /* ─────────────── a trilha ─────────────── */

  const passos: readonly Passo[] = [1, 2, 3].map((n): Passo => {
    const numero = n as NumeroDoPasso;
    const alcancavel = numero === 1 || valido;
    return {
      n: `0${n}`,
      rotulo: NOMES[numero],
      estado: numero === passo ? 'atual' : numero < passo ? 'feito' : alcancavel ? 'pendente' : 'bloqueado',
      ...(alcancavel && numero !== passo ? { aoIr: () => irParaPasso(numero) } : {}),
    };
  });
  const trilha: readonly Passo[] = [...passos, { n: '04', rotulo: 'NO AR', estado: 'pendente' }];

  const resumoAudio =
    modoAudio === 'display-media'
      ? 'SISTEMA'
      : modoAudio === 'monitor-device'
        ? audioDeviceId === null
          ? 'SEM ÁUDIO'
          : 'ENTRADA'
        : 'MUDO';

  return (
    <div className="flex min-h-dvh flex-col bg-void">
      <VidroCrt />
      <Cabecalho marcaHref="/">
        <BotoesDoCabecalho
          aoDiagnostico={() => setModal('diagnostico')}
          aoBaixarApp={() => setModal('app')}
        />
        <LinkTecla href="/recuperar">
          <span className="hidden lg:inline">CÓDIGO DE RECUPERAÇÃO</span>
          <span className="lg:hidden">RECUPERAR</span>
        </LinkTecla>
      </Cabecalho>

      <main className="flex flex-1 flex-col bg-[radial-gradient(ellipse_80%_70%_at_50%_40%,#15161a_0%,#0b0c0e_70%)]">
        {/* A troca de passo é anunciada; o chiado e o número são só pintura. */}
        <p className="sr-only" role="status">
          Passo {passo} de 4: {NOMES[passo]}
        </p>

        <div className="mx-auto w-full max-w-[1180px] px-4 pt-6 sm:px-6 sm:pt-7">
          <Passos passos={trilha} />
        </div>

        {passo === 1 && (
          <section
            aria-labelledby="titulo-canal"
            className="mx-auto my-auto grid w-full max-w-[1180px] items-center gap-10 px-4 py-9 sm:px-6 sm:py-12 lg:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div className="flex min-w-0 max-w-[860px] flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h1 id="titulo-canal" data-vidro="texto" className="rotulo m-0 !text-[13px] !text-muted">
                  DÊ UM NOME AO SEU CANAL
                </h1>
                <p data-vidro="texto" className="m-0 text-[12px] leading-relaxed text-muted">
                  Vira o endereço que seus amigos vão abrir. Letras, números e hífen.
                </p>
              </div>

              <CampoCanal
                value={slug}
                onChange={setSlug}
                onEnter={() => irParaPasso(2)}
                status={check.status === 'ok' ? 'free' : check.status === 'invalid' ? 'invalid' : 'idle'}
                error={check.status === 'invalid' ? check.message : null}
              />

              <div data-vidro="acento" className="w-full sm:w-auto sm:self-start">
                <Botao
                  tom="primaria"
                  grande
                  bloco
                  onClick={() => irParaPasso(2)}
                  disabled={!valido}
                  icone={<span aria-hidden="true" className="h-3 w-3 bg-[#b3261a] shadow-[inset_0_0_0_2px_#14100a]" />}
                >
                  TRANSMITIR
                </Botao>
              </div>
            </div>

            <Vitrine canvasRef={vitrine.canvasRef} montado={vitrine.disponivel} />
          </section>
        )}

        {/*
          Passo 02: só a resolução, num card centralizado. A escolha entre tela,
          janela e aba é do seletor do próprio navegador, que abre ao ir ao ar —
          repetir as três opções aqui era pedir a mesma decisão duas vezes.
        */}
        {passo === 2 && (
          <section aria-label="Tela ou jogo" className="mx-auto my-auto w-full max-w-[760px] px-4 py-8 sm:px-6">
            <PainelOsd titulo="MENU ▸ IMAGEM" direita={`${indice + 1}/${PRESET_ORDER.length}`}>
              <div {...menu.propsContainer}>
                <SeletorDeResolucao
                  opcoes={opcoesDeResolucao}
                  escolhido={presetId}
                  sustentavel={sustentavel}
                  ajuda={ajudaResolucao}
                  aoEscolher={(id) => {
                    if (isPresetId(id)) escolherPreset(id);
                  }}
                  propsGrupo={menu.propsLinha('resolucao')}
                />
              </div>
              <RodapeDoPasso>
                <Botao onClick={() => irParaPasso(1)}>VOLTAR</Botao>
                <Botao tom="primaria" bloco onClick={() => irParaPasso(3)}>
                  CONTINUAR ▸ ÁUDIO
                </Botao>
              </RodapeDoPasso>
            </PainelOsd>
          </section>
        )}

        {/*
          Passo 03: o card do som no centro. As instruções do sistema (script do
          Linux, lista de entradas, aviso do Windows) ficam atrás de um botão,
          abaixo do card: quem já configurou uma vez não precisa relê-las.
        */}
        {passo === 3 && (
          <section aria-label="Áudio" className="mx-auto my-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-8 sm:px-6">
            <PainelOsd titulo="MENU ▸ SOM" direita={menu.posicao}>
              <MenuOsd
                rotulo="Ajustes do som"
                linhas={linhas}
                ativo={menu.ativo}
                propsContainer={menu.propsContainer}
                propsLinha={menu.propsLinha}
                aoAjustar={ajustar}
                aoDefinirBarra={(_, pct) => som.definir(pct / 100)}
                aoSelecionar={menu.selecionar}
              />
              <Medidor
                rotulo="Resumo do que vai ao ar"
                colunas={3}
                tamanho="p"
                medidas={[
                  { rotulo: 'IMAGEM', valor: rotuloDoPreset(presetId) },
                  { rotulo: 'ÁUDIO', valor: resumoAudio },
                  { rotulo: 'VOLUME', valor: resumoAudio === 'MUDO' ? '—' : `${Math.round(som.volume * 100)}%` },
                ]}
              />
              <div className="border-t-2 border-line px-3.5 py-3">
                <button
                  type="button"
                  aria-expanded={comoAudio}
                  aria-controls="como-audio"
                  onClick={() => setComoAudio((v) => !v)}
                  className="tecla w-full justify-between"
                >
                  <span>
                    {modoAudio === 'monitor-device' ? 'ESCOLHER O SOM DO JOGO (LINUX)' : 'COMO O SOM DO JOGO VAI JUNTO'}
                  </span>
                  <span aria-hidden="true" className={`transition-transform duration-200 ${comoAudio ? 'rotate-180' : ''}`}>
                    ▾
                  </span>
                </button>
              </div>
              <RodapeDoPasso>
                <Botao onClick={() => irParaPasso(2)}>VOLTAR</Botao>
                <Botao
                  tom="primaria"
                  bloco
                  onClick={iniciar}
                  icone={<span aria-hidden="true" className="h-2.5 w-2.5 bg-[#b3261a] shadow-[inset_0_0_0_2px_#14100a]" />}
                >
                  IR AO AR E GERAR LINK
                </Botao>
              </RodapeDoPasso>
            </PainelOsd>

            {comoAudio && (
              <div id="como-audio" className="entra border-2 border-line bg-surface p-4 sm:p-5">
                <AudioSourcePicker
                  os={os}
                  mode={modoAudio}
                  devices={fontes.devices}
                  value={audioDeviceId}
                  onChange={setAudioDeviceId}
                  onRequestDevices={fontes.procurar}
                  buscando={fontes.buscando}
                />
              </div>
            )}
          </section>
        )}
      </main>

      <BarraAjuda
        dicas={[
          { tecla: '↑↓', texto: 'SELECIONAR' },
          { tecla: '←→', texto: 'AJUSTAR' },
          { tecla: 'ENTER', texto: passo === 3 ? 'IR AO AR' : 'CONTINUAR' },
        ]}
      />

      <ModalDiagnosticoPreAr aberto={modal === 'diagnostico'} aoFechar={fecharModal} />
      <ModalApp aberto={modal === 'app'} aoFechar={fecharModal} />

      <EstaticaTroca ativa={troca.estatica} />
      <CanalFlash visivel={troca.flash} numero={`0${passo}`} nome={NOMES[passo]} />
    </div>
  );
}

function RodapeDoPasso({ children }: { readonly children: React.ReactNode }) {
  return <div className="flex gap-2 border-t-2 border-line p-3.5">{children}</div>;
}
