import { Botao } from './Botao.js';
import { Led } from './Led.js';

export type PedidoNaFila = { readonly peerId: string; readonly nome: string };

type Props = {
  readonly pedidos: readonly PedidoNaFila[];
  readonly aoAceitar: (peerId: string) => void;
  readonly aoRecusar: (peerId: string) => void;
};

/**
 * Quem está pedindo para assistir (ADR 0025).
 *
 * Fica acima dos avisos, no topo da coluna: é a única coisa no console que
 * alguém do outro lado está esperando. Aceitar é a ação primária — na prática
 * quase todo pedido é um amigo que já está na call —, recusar fica ao lado,
 * sem confirmação: a pessoa pode pedir de novo.
 */
export function FilaDePedidos({ pedidos, aoAceitar, aoRecusar }: Props) {
  if (pedidos.length === 0) return null;
  return (
    <section
      aria-label="Pedidos para assistir"
      className="entra border-2 border-accent bg-[rgb(242_169_59_/_0.06)] shadow-[0_0_24px_rgb(242_169_59_/_0.15)]"
    >
      <header className="flex items-center gap-2.5 border-b-2 border-accent/40 px-3.5 py-2.5 font-[family-name:var(--font-pixel)] text-[12px] text-accent-hi">
        <Led cor="ok" pisca />
        {pedidos.length === 1 ? 'ALGUÉM QUER ASSISTIR' : `${pedidos.length} PESSOAS QUEREM ASSISTIR`}
      </header>
      <ul className="m-0 flex list-none flex-col p-0">
        {pedidos.map((p) => (
          <li
            key={p.peerId}
            className="flex flex-wrap items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
          >
            <span className="numeral min-w-0 flex-1 truncate text-[22px] leading-none text-text">{p.nome}</span>
            <div className="flex gap-2">
              <Botao onClick={() => aoRecusar(p.peerId)} aria-label={`Recusar ${p.nome}`}>
                RECUSAR
              </Botao>
              <Botao tom="primaria" onClick={() => aoAceitar(p.peerId)} aria-label={`Aceitar ${p.nome}`}>
                ACEITAR
              </Botao>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
