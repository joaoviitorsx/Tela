import { Botao } from './Botao.js';
import { Medidor, type Medida, type Tom } from './Medidor.js';

export type LinhaEspectador = {
  readonly id: string;
  readonly nome: string;
  readonly rota: string;
  readonly estado: string;
  readonly tom: Tom;
};

type Props = {
  readonly resumo: readonly Medida[];
  readonly espectadores: readonly LinhaEspectador[];
  readonly audio: { readonly texto: string; readonly tom: Tom };
  readonly copiado: boolean;
  readonly aoCopiar: () => void;
};

const COR: Record<Tom, string> = {
  neutro: 'text-text',
  destaque: 'text-accent-hi',
  ok: 'text-ok',
  alerta: 'text-warn',
};

/**
 * O conteúdo do modal de diagnóstico: só o que a sessão mede.
 *
 * O protótipo trazia latência e perda POR espectador e um botão "testar
 * rede". A sessão não tem nenhuma das duas coisas — o transporte agrega, e o
 * único jeito honesto de saber a subida é a própria transmissão —, então não
 * estão aqui. Por espectador há o que o `PeerInfo` carrega: o estado da
 * conexão e se o caminho é direto ou passa pelo TURN.
 */
export function DiagnosticoConteudo({ resumo, espectadores, audio, copiado, aoCopiar }: Props) {
  return (
    <div className="flex flex-col gap-5 p-4 sm:p-5">
      <div className="border-2 border-line bg-surface">
        <Medidor rotulo="Resumo da transmissão" medidas={resumo} colunas={4} />
      </div>

      <div className="border-2 border-line bg-surface">
        {espectadores.length === 0 ? (
          <p className="m-0 p-4 text-[12px] text-dim">
            Ninguém assistindo ainda. Os espectadores aparecem aqui quando entrarem.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-left">
              <caption className="sr-only">Espectadores conectados</caption>
              <thead>
                <tr className="border-b-2 border-line">
                  {['ESPECTADOR', 'ROTA', 'ESTADO'].map((c) => (
                    <th key={c} scope="col" className="rotulo px-4 py-2.5 font-normal">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {espectadores.map((e) => (
                  <tr key={e.id} className="border-b-2 border-line last:border-b-0">
                    <th scope="row" className="rotulo-forte px-4 py-3 text-left font-normal">
                      {e.nome}
                    </th>
                    <td className={`px-4 py-3 font-[family-name:var(--font-pixel)] text-[11px] ${COR[e.rota === 'TURN (relay)' ? 'alerta' : 'ok']}`}>
                      {e.rota === 'TURN (relay)' ? '! ' : ''}
                      {e.rota}
                    </td>
                    <td className={`px-4 py-3 font-[family-name:var(--font-pixel)] text-[11px] ${COR[e.tom]}`}>
                      {e.estado}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="m-0 border-t-2 border-line px-4 py-3 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
          P2P direto quando dá. Quando a rede de alguém bloqueia a conexão direta, o vídeo passa
          pelo TURN: funciona, com um pouco mais de latência. A latência e a perda por espectador
          não são medidas separadamente; o painel mostra o pior RTT entre todos.
        </p>
      </div>

      <p
        className={`m-0 flex items-start gap-2 text-[12px] leading-relaxed ${COR[audio.tom]}`}
      >
        <span className="rotulo text-current">ÁUDIO</span>
        <span>{audio.texto}</span>
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Botao tom="primaria" onClick={aoCopiar}>
          {copiado ? 'DIAGNÓSTICO COPIADO' : 'COPIAR DIAGNÓSTICO'}
        </Botao>
        <span className="max-w-[46ch] text-[11px] leading-relaxed text-dim [text-wrap:pretty]">
          Copia um relatório em JSON com a série medida desta transmissão. Nada sai da sua máquina
          sozinho: quem decide se manda é você.
        </span>
      </div>
    </div>
  );
}
