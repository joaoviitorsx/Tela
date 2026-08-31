import { P2P_LIMITS, PRESETS, PRESET_ORDER, type PresetId } from '@tela/shared';
import { useCallback, useMemo, useState } from 'react';
import { Vitrine } from '../components/Vitrine.js';
import { AudioSourcePicker } from '../components/AudioSourcePicker.js';
import { BigButton } from '../components/BigButton.js';
import { IconPlay } from '../components/Icon.js';
import { Masthead } from '../components/Masthead.js';
import { QualityPicker } from '../components/QualityPicker.js';
import { SignalChain } from '../components/SignalChain.js';
import { SlugPicker } from '../components/SlugPicker.js';
import { audioCue, identity, platform, preferences, presetSustentavel } from '../container.js';
import { isPresetId } from '../core/media/presets.js';
import { useAudioSources } from '../react/use-audio-sources.js';
import { useSlugCheck } from '../react/use-slug-check.js';
import { useVitrine } from '../react/use-vitrine.js';

type Props = {
  readonly onStart: (slug: string, presetId: PresetId, audioDeviceId: string | null) => void;
};

/**
 * A chapa frontal do produto.
 *
 * # O que mudou, e por quê
 *
 * A versão anterior punha a página inteira dentro de UM cartão arredondado com
 * a palavra "tela" em minúsculas no canto. Três problemas, e nenhum é gosto:
 *
 * 1. **O cartão.** Uma chapa flutuando sobre o vazio faz o produto parecer um
 *    formulário hospedado numa página. Agora as faixas atravessam a janela de
 *    ponta a ponta e o que as separa são filetes de 1px; quem respeita a coluna
 *    de 1180px é o conteúdo, não a moldura. A referência declarada é painel de
 *    aparelho de vídeo — painel não tem canto arredondado flutuando no ar.
 *
 * 2. **A coluna da direita.** "Por que isto existe" ocupava 380px permanentes
 *    para explicar o produto a quem já clicou no link dele. Os dois fatos que
 *    valiam foram para onde são úteis: "a aba precisa ficar aberta" ficou
 *    embaixo do botão, que é onde a decisão acontece, e "até 5 ao mesmo tempo"
 *    virou DESENHO no caminho do vídeo, em vez de frase.
 *
 * 3. **O eixo.** Campo, botão, qualidade, áudio e caminho começam todos no
 *    mesmo x. Um eixo esquerdo único é o que faz cinco regiões diferentes
 *    lerem como um aparelho só — e é o que a versão centralizada não tinha.
 *
 * # A ordem no DOM
 *
 * Campo, depois botão. Antes o botão vinha primeiro, então quem navega por
 * teclado tabulava para um botão desabilitado antes de chegar no campo que o
 * habilita.
 *
 * Continua sem reserva de slug: sem API HTTP, quem decide se o nome está livre
 * é o servidor de sinalização, no `host`. O usuário descobre ao apertar
 * TRANSMITIR. Em troca, digitar não faz uma requisição por tecla e não existe
 * endpoint que sirva para varrer quem existe.
 */
export function Home({ onStart }: Props) {
  const [slug, setSlug] = useState(() => identity.savedSlug() ?? '');
  const [presetId, setPresetId] = useState<PresetId>(() => {
    const saved = preferences.read();
    return isPresetId(saved) ? saved : 'p1080p60';
  });

  const [audioDeviceId, setAudioDeviceId] = useState<string | null>(null);
  const check = useSlugCheck(slug);
  const presets = useMemo(() => PRESET_ORDER.map((id) => PRESETS[id]), []);
  /*
    O que o link da última transmissão sustentou — lido uma vez, porque é
    preferência gravada e não muda enquanto a página está aberta.
  */
  const sustentavel = useMemo(() => presetSustentavel(), []);
  const fontes = useAudioSources();
  const os = platform.osName();
  const modoAudio = platform.systemAudio();

  const choosePreset = useCallback((id: PresetId) => {
    setPresetId(id);
    preferences.write(id);
  }, []);

  const handleStart = useCallback(() => {
    const wanted = slug.trim().toLowerCase();
    if (check.status !== 'ok') return;
    // §10 da coreografia: a abertura é muda, e o chiado entra como recompensa
    // do primeiro gesto. Este é o gesto.
    audioCue.estouro();
    identity.rememberSlug(wanted);
    onStart(wanted, presetId, audioDeviceId);
  }, [slug, check, presetId, audioDeviceId, onStart]);

  /**
   * O que o tubo da vitrine mostra.
   *
   * É o MESMO dado do campo, traduzido para o vocabulário do aparelho: o
   * endereço na tela e o estado numa lâmpada. Não há segunda fonte de verdade —
   * se o campo mudar de regra, o tubo muda junto, porque ele lê daqui.
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

  const focaOCampo = useCallback(() => {
    document.getElementById('slug')?.focus();
  }, []);

  const vitrine = useVitrine(noTubo, focaOCampo);

  const preset = PRESETS[presetId];
  const maiorCamada = preset;
  const teto = P2P_LIMITS.maxViewersBrowser;

  /**
   * O caminho do vídeo com os números do preset SELECIONADO.
   *
   * Tudo aqui já existe em `@tela/shared` e nada é medido nem estimado: a
   * resolução e o framerate vêm da camada principal do preset, o Mbps vem de
   * `main.maxBitrate`, o teto vem de `P2P_LIMITS`. Trocar de 1080p60 para
   * 720p60 muda estes números na hora — é a única forma honesta de responder
   * "o que muda se eu mexer aqui" antes de a transmissão existir.
   *
   * O último nó não tem valor escrito: tem o leque. Ver `SignalChain`.
   */
  const caminho = useMemo(
    () => [
      {
        rotulo: 'sua tela',
        valor: `${maiorCamada.width}×${maiorCamada.height}`,
        nota: 'a janela ou a tela que você escolher no seletor',
      },
      {
        rotulo: 'seu PC codifica',
        valor: `h264 · ${preset.main.maxFramerate}fps`,
        nota: 'na sua placa de vídeo, com a qualidade escolhida ali em cima',
      },
      {
        rotulo: 'sobe direto',
        valor: `${(preset.main.maxBitrate / 1_000_000).toFixed(1)} Mbps`,
        nota: 'por espectador — não passa por servidor de vídeo nenhum',
      },
      {
        rotulo: 'chega nos amigos',
        valor: `até ${teto}`,
        nota: `uma cópia inteira do vídeo para cada um, saindo da sua máquina. O que limita é a sua subida, não um servidor.`,
      },
    ],
    [maiorCamada, preset, teto],
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <Masthead tamanho="grande">
        <a
          href="/recuperar"
          className="inline-flex min-h-11 items-center rounded-sm px-2 text-[13px] text-muted underline decoration-line underline-offset-4 transition-colors duration-150 hover:text-text hover:decoration-text"
        >
          código de recuperação
        </a>
      </Masthead>

      <main className="flex flex-1 flex-col">
        {/*
          O canal. A folga vertical toda vive aqui — `flex-1` com o conteúdo
          centrado verticalmente. A sobra vira respiro em volta do TRANSMITIR,
          que é onde ela vale alguma coisa, em vez de virar um vazio pendurado
          embaixo do último filete.

          MEDIDO, e a medida mudou os números. Em 1024×900 a faixa tinha 453px
          para 340px de conteúdo: os 113px de diferença eram `py-14` puro, e não
          o `flex-1` esticando. Em 1920×1080 aí sim o `flex-1` acrescentava mais
          62px por cima do padding.

          Duas correções, e as duas medidas. A folga de `sm` cai de 56 para
          40px, que continua sendo respiro e para de ler como buraco entre o
          botão e o filete de QUALIDADE. E `max-h` limita o quanto a faixa pode
          crescer: acima disso a sobra desce para o resto da página, onde vira
          conteúdo acima da dobra em vez de vazio no meio dela.
        */}
        <section className="flex max-h-[560px] flex-1 items-center border-b border-line py-10 sm:py-10 lg:py-12">
          {/*
            Campo à esquerda, aparelho à direita.

            A metade direita da faixa estava vazia desde que a coluna de texto
            saiu (ADR 0012), e o que entrou nela não é enfeite: é o monitor do
            canal que está sendo criado. O que a pessoa digita aparece no tubo,
            e as lâmpadas da lateral são o estado do nome. Campo vazio, o tubo
            mostra chiado e SEM SINAL — que é exatamente o que o canal é antes
            de ter nome.

            `items-center` e não `items-start`: o aparelho tem centro óptico e
            alinhá-lo pelo topo do rótulo o deixa pendurado.
          */}
          <div className="mx-auto flex w-full max-w-[1180px] items-center gap-10 px-4 sm:px-6">
            <div className="flex w-full min-w-0 max-w-[860px] flex-1 flex-col gap-6">
              <h1 data-vidro="texto" className="serigrafia">
                seu canal
              </h1>

              <SlugPicker
                value={slug}
                onChange={setSlug}
                tamanho="heroi"
                status={
                  check.status === 'ok' ? 'free' : check.status === 'invalid' ? 'invalid' : 'idle'
                }
                error={check.status === 'invalid' ? check.message : null}
              />

              {/*
                Botão e aviso na mesma linha, e não empilhados.

                Empilhado e ocupando a coluna inteira, o TRANSMITIR virava uma
                barra de 860×56 de verde puro — o acento é o recurso mais escasso
                da paleta (ADR 0008) e ali ele era a maior área de cor da tela,
                com a metade direita da faixa vazia do lado. Em 300px ele continua
                sendo o único elemento verde, o maior alvo e o mais alto contraste
                da página, e o espaço que sobrava passa a explicar o que acontece
                depois de apertá-lo.

                No celular volta a empilhar: 300px de botão ao lado de um texto
                de 13px não cabem em 360px de largura.
              */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
                <div data-vidro="acento" className="w-full sm:w-[300px] sm:shrink-0">
                  <BigButton
                    onClick={handleStart}
                    disabled={check.status !== 'ok'}
                    bloco
                    icon={<IconPlay className="h-4 w-4" />}
                  >
                    TRANSMITIR
                  </BigButton>
                </div>

                {/*
                  Um dos dois fatos que a coluna da direita carregava. Ele mora
                  aqui porque é o único que muda o comportamento de quem está
                  prestes a apertar o botão — fechar a aba encerra a transmissão,
                  e ninguém deduz isso sozinho.
                */}
                <p data-vidro="texto" className="text-[13px] leading-snug text-muted">
                  A aba precisa ficar aberta enquanto você joga. Ela não precisa estar
                  visível — pode ficar atrás do jogo.
                </p>
              </div>
            </div>

            <Vitrine canvasRef={vitrine.canvasRef} montado={vitrine.disponivel} />
          </div>
        </section>

        {/* O console: os dois ajustes, lado a lado. Nenhum deles decide nada sozinho. */}
        <section className="border-b border-line">
          <div className="mx-auto grid w-full max-w-[1180px] px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="py-5 lg:pr-6">
              <h2 data-vidro="texto" className="serigrafia mb-3">
                qualidade
              </h2>
              <QualityPicker
                presets={presets}
                value={presetId}
                onChange={choosePreset}
                {...(sustentavel === null ? {} : { sustentavel })}
              />
            </div>

            <div className="border-t border-line py-5 lg:border-l lg:border-t-0 lg:pl-6">
              <h2 data-vidro="texto" className="serigrafia mb-3">
                áudio do jogo
              </h2>
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
          </div>
        </section>

        {/*
          Região `surface`: só leitura, zero controle. É a regra de contraste da
          ADR 0008 — `edge` mede 2,92:1 sobre `surface` e 3,13:1 sobre `void`,
          então nada que se aperte senta aqui.
        */}
        <section data-vidro="preenchido" className="bg-surface">
          <div className="mx-auto w-full max-w-[1180px] px-4 py-7 sm:px-6">
            <SignalChain rotulo="caminho do vídeo" nodes={caminho} saidas={{ total: teto }} />
          </div>
        </section>
      </main>

      {/*
        A última linha da página, e a única que fala de contexto.
        
        Era uma coluna de 380px com dois parágrafos. O que sobrou é o que
        ninguém consegue deduzir olhando a tela: por que este produto apareceu
        agora, e o que substitui a senha que ele não pede.
      */}
      <footer className="border-t border-line py-4">
        <p
          data-vidro="texto"
          className="mx-auto w-full max-w-[1180px] px-4 text-[12.5px] leading-relaxed text-muted sm:px-6"
        >
          <span className="block max-w-[78ch]">
            Desde 17 de agosto de 2026 o Discord não compartilha tela no Brasil, por ordem
            da ANPD — texto e voz continuam funcionando. Tela entrega só o que faltou: o
            vídeo. Sem cadastro e sem senha: quem prova que o link é seu é um código
            guardado neste navegador.
          </span>
        </p>
      </footer>
    </div>
  );
}
