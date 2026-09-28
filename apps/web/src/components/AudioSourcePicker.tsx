import type { ReactNode } from 'react';

export type AudioDeviceOption = {
  readonly id: string;
  readonly label: string;
  /** `entrada` é quase sempre microfone: fica num grupo à parte, nomeado. */
  readonly tipo: 'monitor' | 'entrada';
};

type Props = {
  readonly os: 'windows' | 'linux' | 'macos' | 'desconhecido';
  readonly mode: 'display-media' | 'monitor-device' | 'unsupported';
  readonly devices: readonly AudioDeviceOption[];
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly onRequestDevices: () => void;
  readonly buscando: boolean;
};

/**
 * Áudio do jogo — a única parte do produto que muda de verdade entre sistemas.
 *
 * Windows: o Chrome entrega o áudio junto com a tela, então não há o que
 * escolher. A UI só lembra de marcar a caixa no picker do sistema, que é o
 * passo que todo mundo esquece.
 *
 * Linux: o Chrome NÃO entrega áudio do sistema, só de aba. Jogo nativo sai
 * mudo, e nada na interface do browser explica isso. Aqui a instrução é
 * explícita, com o comando pronto para copiar.
 *
 * macOS: exige driver de terceiro. Dizer isso é melhor que prometer e
 * entregar silêncio.
 */
export function AudioSourcePicker({
  os,
  mode,
  devices,
  value,
  onChange,
  onRequestDevices,
  buscando,
}: Props) {
  /**
   * Recolhido por padrão.
   *
   * A instrução do Linux é longa e traz um comando de terminal — necessário
   * para quem precisa, e ruído para quem não precisa. Deixá-la aberta na tela
   * inicial fazia o produto parecer um manual. O resumo diz em uma linha o que
   * acontece com o áudio neste sistema; quem quiser os detalhes abre.
   */
  return (
    <details className="group w-full">
      <summary
        data-vidro="texto"
        className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] text-muted transition-colors duration-150 hover:text-text"
      >
        <span className="inline-block transition-transform duration-150 group-open:rotate-90">›</span>
        {RESUMO[mode]}
      </summary>

      <div className="mt-2">
      {mode === 'display-media' && <Nota>{TEXTO_WINDOWS}</Nota>}
      {mode === 'unsupported' && <Nota tone="warn">{textoSemSuporte(os)}</Nota>}

      {mode === 'monitor-device' && (
        <div className="flex flex-col gap-2">
          <Nota>{TEXTO_LINUX}</Nota>

          <pre className="tabular overflow-x-auto rounded-md border border-line bg-surface p-3 text-[12px] leading-relaxed text-muted">
{`pactl load-module module-null-sink sink_name=tela_cap \\
  sink_properties=device.description=TelaCapture
pactl load-module module-loopback source=tela_cap.monitor \\
  sink="$(pactl get-default-sink)" latency_msec=1`}
          </pre>

          {devices.length === 0 ? (
            <button
              type="button"
              onClick={onRequestDevices}
              disabled={buscando}
              className="inline-flex min-h-11 items-center justify-center self-start rounded-md border border-edge bg-void px-4 text-[13px] text-text transition-colors duration-150 hover:border-text disabled:opacity-50"
            >
              {buscando ? 'procurando…' : 'procurar entradas de áudio'}
            </button>
          ) : (
            <>
              <label htmlFor="audio-src" className="sr-only">
                Entrada de áudio
              </label>
              <select
                id="audio-src"
                value={value ?? ''}
                onChange={(event) => onChange(event.target.value || null)}
                className="min-h-11 rounded-md border border-edge bg-void px-3 text-[13px] outline-none transition-colors focus:border-text"
              >
                <option value="">transmitir sem áudio</option>
                {/*
                  Monitores e entradas em grupos separados. Quando nenhum nome
                  parece monitor a lista traz TODAS as entradas, e um microfone
                  escolhido sem saber transmite a voz de quem joga, não o jogo.
                  Nada é pré-selecionado: o padrão continua "sem áudio".
                */}
                {devices.some((d) => d.tipo === 'monitor') && (
                  <optgroup label="som do sistema (monitor)">
                    {devices
                      .filter((d) => d.tipo === 'monitor')
                      .map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.label}
                        </option>
                      ))}
                  </optgroup>
                )}
                {devices.some((d) => d.tipo === 'entrada') && (
                  <optgroup label="outras entradas — microfone, não o jogo">
                    {devices
                      .filter((d) => d.tipo === 'entrada')
                      .map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.label}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </>
          )}
        </div>
      )}
      </div>
    </details>
  );
}

/**
 * O que o usuário precisa saber em uma linha, antes de decidir se abre.
 *
 * Eram continuações da frase "Áudio do jogo — …", que o próprio componente
 * escrevia. Quem rotula a região agora é a serigrafia da chapa; repetir
 * "Áudio do jogo" logo abaixo dela seria a mesma palavra duas vezes, então o
 * resumo virou frase inteira.
 */
const RESUMO: Record<Props['mode'], string> = {
  'display-media': 'Vem junto com a tela — só não esqueça de marcar a caixa',
  'monitor-device': 'No Linux precisa de um passo a mais',
  unsupported: 'Não disponível neste sistema',
};

function Nota({ children, tone = 'dim' }: { children: ReactNode; tone?: 'dim' | 'warn' }) {
  return (
    <p className={`text-[13px] leading-relaxed ${tone === 'warn' ? 'text-warn' : 'text-muted'}`}>
      {children}
    </p>
  );
}

const TEXTO_WINDOWS =
  'O seletor já abre em "Tela inteira". Só falta marcar "Compartilhar áudio do sistema" antes de confirmar — se esquecer, a transmissão vai muda e o HUD avisa.';

const TEXTO_LINUX =
  'O Chrome no Linux não entrega áudio do sistema, só de aba. Para o som do jogo chegar aos seus amigos, crie um sink virtual, mande o jogo para ele no pavucontrol e escolha o monitor abaixo:';

function textoSemSuporte(os: Props['os']): string {
  return os === 'macos'
    ? 'No macOS o áudio do sistema exige um driver de terceiro (BlackHole ou Loopback). Sem ele a transmissão vai muda.'
    : 'Não foi possível identificar seu sistema. O áudio do jogo pode não ser capturado.';
}
