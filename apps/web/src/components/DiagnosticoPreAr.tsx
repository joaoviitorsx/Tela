import type { ReactNode } from 'react';
import { Medidor, type Medida } from './Medidor.js';

type Props = {
  readonly resumo: readonly Medida[];
  /** O teste de rede, montado por quem tem o estado. */
  readonly teste: ReactNode;
};

/**
 * Diagnóstico antes de ir ao ar: o que dá para saber sem transmissão.
 *
 * O protótipo mostrava "SUA SUBIDA 48 Mbps" antes do ar. Medir subida exige
 * mandar tráfego para algum lugar, e o Tela não tem servidor de mídia; então
 * esse número só existe ao vivo, medido pelo próprio envio. O que dá para
 * testar antes é se a rede deixa conexão direta — e isso o teste faz de verdade.
 */
export function DiagnosticoPreAr({ resumo, teste }: Props) {
  return (
    <div className="flex flex-col gap-5 p-4 sm:p-5">
      <div className="border-2 border-line bg-surface">
        <Medidor rotulo="Resumo da rede" medidas={resumo} colunas={4} tamanho="g" />
      </div>
      <div className="border-2 border-line bg-surface">
        <p className="m-0 p-4 text-[12px] text-dim">
          Ninguém assistindo ainda. Os espectadores aparecem aqui quando você estiver no ar.
        </p>
        <p className="m-0 border-t-2 border-line px-4 py-3 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
          P2P direto quando dá. Quando a rede de alguém bloqueia a conexão direta, o vídeo passa pelo
          TURN — funciona, mas com um pouco mais de latência.
        </p>
      </div>
      {teste}
    </div>
  );
}
