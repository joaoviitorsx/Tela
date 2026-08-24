import { P2P_LIMITS, PRESETS, PRESET_ORDER, type PresetId } from '@tela/shared';
import { useCallback, useMemo, useState } from 'react';
import { AudioSourcePicker } from '../components/AudioSourcePicker.js';
import { BigButton } from '../components/BigButton.js';
import { IconPlay } from '../components/Icon.js';
import { Masthead } from '../components/Masthead.js';
import { Panel, PanelSection } from '../components/Panel.js';
import { QualityPicker } from '../components/QualityPicker.js';
import { SignalChain } from '../components/SignalChain.js';
import { SlugPicker } from '../components/SlugPicker.js';
import { identity, platform, preferences } from '../container.js';
import { isPresetId } from '../core/media/presets.js';
import { useAudioSources } from '../react/use-audio-sources.js';
import { useSlugCheck } from '../react/use-slug-check.js';

type Props = {
  readonly onStart: (slug: string, presetId: PresetId, audioDeviceId: string | null) => void;
};

/**
 * A chapa frontal do produto.
 *
 * # O que era, e por que mudou
 *
 * Era literalmente um botão e um campo empilhados no meio de 1440×900 de
 * preto, com uns 500px vazios de cada lado. A regra que produziu isso — ADR
 * 0008 §4, "a tela inicial volta a ser um botão e um campo" — resolvia um
 * problema real: a escolha de qualidade tinha virado quatro cartões e
 * empurrado o botão para 10% da página.
 *
 * O que essa regra nunca disse é que a página precisa ser VAZIA. Ela disse que
 * o botão tem que dominar. Aqui ele continua dominando — é o único elemento
 * verde, ocupa a largura da coluna principal e tem 56px de altura — e o resto
 * do espaço passa a fazer trabalho:
 *
 * - o campo do link virou o maior texto da tela, porque o link É o produto;
 * - a coluna da direita explica por que este produto existe, o que é a única
 *   coisa que ninguém consegue deduzir sozinho olhando um campo de texto;
 * - o rodapé desenha o caminho do vídeo, com os números do preset ESCOLHIDO.
 *
 * Nada disso é funcionalidade nova (R6): é o dado que já estava em
 * `@tela/shared` e o contexto que já estava no AGENTS.md, colocados onde a
 * pessoa lê antes de decidir em vez de depois.
 *
 * # Duas decisões antigas que eu contrariei, e por quê
 *
 * A docstring anterior dizia "sem header, sem logo, sem rodapé". Ganhou uma
 * faixa de 52px porque `/recuperar` — a página que torna o "sem cadastro"
 * honesto — não tinha NENHUM caminho de chegada: só digitando o endereço na
 * mão. Um recurso inalcançável é um recurso que não existe.
 *
 * E a ordem no DOM mudou: campo, depois botão. Antes o botão vinha primeiro,
 * então quem navega por teclado tabulava para um botão desabilitado antes de
 * chegar no campo que o habilita.
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
    identity.rememberSlug(wanted);
    onStart(wanted, presetId, audioDeviceId);
  }, [slug, check, presetId, audioDeviceId, onStart]);

  const preset = PRESETS[presetId];
  const maiorCamada = preset.layers[0];
  const teto = P2P_LIMITS.maxViewersBrowser;

  /**
   * O caminho do vídeo com os números do preset SELECIONADO.
   *
   * Tudo aqui já existe em `@tela/shared` e nada é medido nem estimado: a
   * resolução e o framerate vêm da camada principal do preset, o Mbps vem de
   * `main.maxBitrate`, o teto vem de `P2P_LIMITS`. Trocar de 1080p60 para
   * 720p60 muda estes números na hora — é a única forma honesta de responder
   * "o que muda se eu mexer aqui" antes de a transmissão existir.
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
        nota: 'na sua placa de vídeo, com a qualidade escolhida ao lado',
      },
      {
        rotulo: 'sobe direto',
        valor: `${(preset.main.maxBitrate / 1_000_000).toFixed(1)} Mbps`,
        nota: 'por espectador — não passa por servidor de vídeo nenhum',
      },
      {
        rotulo: 'chega nos amigos',
        valor: `até ${teto}`,
        nota: 'eles abrem o link e veem, sem instalar e sem se cadastrar',
      },
    ],
    [maiorCamada, preset, teto],
  );

  return (
    <div className="flex min-h-dvh flex-col px-4 py-4 sm:px-6 sm:py-8">
      <Panel className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col">
        <Masthead>
          <a
            href="/recuperar"
            className="inline-flex min-h-11 items-center rounded-sm px-2 text-[13px] text-muted underline decoration-line underline-offset-4 transition-colors duration-150 hover:text-text hover:decoration-text"
          >
            código de recuperação
          </a>
        </Masthead>

        {/*
          `items-stretch` com o filete vertical em `lg:border-l` na segunda
          coluna: é o mesmo filete que separa as regiões na horizontal, e é o
          que faz as duas colunas lerem como uma chapa gravada em vez de dois
          cartões encostados.
        */}
        <div className="flex flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:items-stretch">
          {/*
            A folga vertical vai toda para a região do botão, não para o fim da
            coluna. Quando a coluna de texto é mais alta que a console — e ela
            é, em 1440×900 — o `flex-1` aqui faz a sobra virar respiro em volta
            do TRANSMITIR, que é onde ela vale alguma coisa, em vez de virar um
            vazio pendurado embaixo do último filete.
          */}
          <div className="flex flex-col">
            <PanelSection className="flex flex-1 flex-col justify-center gap-5 py-6 sm:py-8">
              <SlugPicker
                value={slug}
                onChange={setSlug}
                tamanho="heroi"
                status={
                  check.status === 'ok' ? 'free' : check.status === 'invalid' ? 'invalid' : 'idle'
                }
                error={check.status === 'invalid' ? check.message : null}
              />

              <BigButton
                onClick={handleStart}
                disabled={check.status !== 'ok'}
                bloco
                icon={<IconPlay className="h-4 w-4" />}
              >
                TRANSMITIR
              </BigButton>
            </PanelSection>

            <PanelSection rotulo="qualidade" className="border-t border-line">
              <QualityPicker presets={presets} value={presetId} onChange={choosePreset} />
            </PanelSection>

            <PanelSection rotulo="áudio do jogo" className="border-t border-line">
              <AudioSourcePicker
                os={os}
                mode={modoAudio}
                devices={fontes.devices}
                value={audioDeviceId}
                onChange={setAudioDeviceId}
                onRequestDevices={fontes.procurar}
                buscando={fontes.buscando}
              />
            </PanelSection>
          </div>

          {/*
            Região `surface`: só texto, zero controle. É a regra de contraste da
            chapa — `edge` mede 2,92:1 sobre `surface` e 3,13:1 sobre `void`,
            então nada que se aperte senta aqui. Ver `Panel.tsx`.
          */}
          <aside className="flex flex-col gap-5 border-t border-line bg-surface px-4 py-6 sm:px-6 lg:border-l lg:border-t-0">
            <div className="flex flex-col gap-3">
              <h2 className="serigrafia">por que isto existe</h2>
              <p className="text-[13.5px] leading-relaxed text-text">
                Desde 17 de agosto de 2026 o Discord não compartilha tela no Brasil, por ordem
                da ANPD. Texto e voz continuam funcionando — vocês já estão na call.
              </p>
              <p className="text-[13.5px] leading-relaxed text-muted">
                Tela entrega só o que faltou: o vídeo. Não tem chat, não tem sala, não tem
                perfil. Você escolhe um nome, aperta um botão e manda o link no Discord que
                já está aberto.
              </p>
            </div>

            <dl className="flex flex-col gap-3 border-t border-line pt-5">
              <Fato rotulo={`até ${teto} ao mesmo tempo`}>
                Cada espectador recebe uma cópia inteira do vídeo direto da sua máquina. O
                que limita é a sua subida, não um servidor.
              </Fato>
              <Fato rotulo="a aba precisa ficar aberta">
                Ela não precisa estar visível — pode ficar atrás do jogo. Só não pode ser
                fechada, porque é dela que o vídeo sai.
              </Fato>
              <Fato rotulo="o link é seu enquanto o navegador for">
                Não há e-mail nem senha: quem prova que o link é seu é um código guardado
                neste navegador.
              </Fato>
            </dl>
          </aside>
        </div>

        <div className="border-t border-line bg-surface px-4 py-6 sm:px-6">
          <SignalChain rotulo="caminho do vídeo" nodes={caminho} />
        </div>
      </Panel>
    </div>
  );
}

function Fato({ rotulo, children }: { readonly rotulo: string; readonly children: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[13px] font-medium text-text">{rotulo}</dt>
      <dd className="text-[12.5px] leading-relaxed text-muted">{children}</dd>
    </div>
  );
}
