import type { ReactNode } from 'react';
/*
  O script vem do repositório, não de uma cópia: a página oferece exatamente o
  que `scripts/audio-linux.test.sh` testa.
*/
import SCRIPT_LINUX from '../../../../scripts/audio-linux.sh?raw';
import { Aviso } from './Aviso.js';
import { LinkTecla, Botao } from './Botao.js';

const SCRIPT_HREF = `data:text/x-shellscript;charset=utf-8,${encodeURIComponent(SCRIPT_LINUX)}`;

export type AudioDeviceOption = {
  readonly id: string;
  readonly label: string;
  readonly tipo: 'monitor' | 'entrada';
};

type Props = {
  readonly os: 'windows' | 'linux' | 'macos' | 'desconhecido';
  /**
   * De onde o som vem neste sistema:
   * - `display-media`: junto com a tela, pela caixa do Chrome (Windows);
   * - `monitor-device`: de uma entrada de áudio escolhida aqui (Linux);
   * - `unsupported`: não há como.
   */
  readonly mode: 'display-media' | 'monitor-device' | 'unsupported';
  readonly devices: readonly AudioDeviceOption[];
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly onRequestDevices: () => void;
  readonly buscando: boolean;
};

const TEXTO_LINUX =
  'O Chrome no Linux não entrega áudio do sistema, só de aba. Para o som do jogo chegar aos seus amigos, rode o script abaixo, mande SÓ o jogo para "TelaCapture" no pavucontrol (a chamada de voz fica onde está) e escolha o monitor:';

function textoSemSuporte(os: Props['os']): string {
  return os === 'macos'
    ? 'No macOS o áudio do sistema exige um driver de terceiro (BlackHole ou Loopback). Sem ele a transmissão vai muda.'
    : 'Não foi possível identificar seu sistema. O áudio do jogo pode não ser capturado.';
}

/**
 * De onde vem o som do jogo, do jeito que cada sistema permite.
 *
 * O protótipo tinha duas opções ("som do sistema" e "sem áudio"), como se a
 * página escolhesse. No navegador não escolhe: no Windows a decisão é uma
 * caixinha na janela do Chrome; no Linux é uma entrada de áudio; no macOS não
 * há. Então esta caixa mostra o que é verdade em cada caso e, onde há uma
 * escolha real (Linux), a oferece.
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
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h2 className="rotulo m-0 text-[12px]">O QUE SEUS AMIGOS VÃO OUVIR?</h2>

      {mode === 'display-media' && (
        <>
          <Cartao nome="SOM DO SISTEMA, VIA CHROME">
            O seletor abre em “Tela inteira”. Seus amigos ouvem o que sai do seu PC, jogo e resto.
          </Cartao>
          <Aviso tom="alerta">
            Na janela do Chrome, marque “Compartilhar áudio do sistema” antes de confirmar. Se
            esquecer, a transmissão vai muda — e o painel ao vivo avisa.
          </Aviso>
        </>
      )}

      {mode === 'unsupported' && <Aviso tom="alerta">{textoSemSuporte(os)}</Aviso>}

      {mode === 'monitor-device' && (
        <>
          <Aviso>{TEXTO_LINUX}</Aviso>

          {/*
            Eram dois `pactl load-module` soltos. Colados duas vezes, criavam
            dois retornos para o fone — som dobrado e eco —, e a instrução de
            desfazer descarregava o loopback de QUALQUER programa. O script
            marca o que cria, não duplica e só remove o que é dele.
          */}
          <div>
            <LinkTecla href={SCRIPT_HREF} download="tela-audio-linux.sh">
              baixar tela-audio-linux.sh
            </LinkTecla>
          </div>
          <pre className="m-0 overflow-x-auto border-2 border-line bg-deep p-3 text-[11px] leading-relaxed text-muted">
{`bash ~/Downloads/tela-audio-linux.sh setup     # cria (repetir não duplica)
bash ~/Downloads/tela-audio-linux.sh status    # confere
bash ~/Downloads/tela-audio-linux.sh cleanup   # remove só o que ele criou`}
          </pre>

          {devices.length === 0 ? (
            <div>
              <Botao onClick={onRequestDevices} disabled={buscando}>
                {buscando ? 'PROCURANDO…' : 'PROCURAR ENTRADAS DE ÁUDIO'}
              </Botao>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="audio-src" className="rotulo">
                ENTRADA DE ÁUDIO
              </label>
              <select
                id="audio-src"
                value={value ?? ''}
                onChange={(event) => onChange(event.target.value || null)}
                className="min-h-11 border-2 border-edge bg-deep px-3 text-[12px] text-text focus:border-accent"
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
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Um cartão de informação, não uma opção: aqui não há o que marcar. Sem o
 * glifo de rádio de propósito — um rádio que não responde ao clique é um
 * controle falso.
 */
function Cartao({
  nome,
  children,
}: {
  readonly nome: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-2 border-accent bg-warn-bg p-4">
      <span className="rotulo-forte text-accent-hi">{nome}</span>
      <span className="text-[11px] leading-relaxed text-muted [text-wrap:pretty]">{children}</span>
    </div>
  );
}
