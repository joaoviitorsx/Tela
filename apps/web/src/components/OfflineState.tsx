import type { ReactNode } from 'react';

export type Motivo =
  | 'conectando'
  | 'offline'
  | 'reconectando'
  | 'cheio'
  | 'sem-conexao'
  | 'relay-indisponivel'
  | 'relay-nao-configurado'
  | 'sem-servidor';

type Props = {
  readonly slug: string;
  readonly motivo?: Motivo;
  /** Vem da rota: o componente não inventa o limite da transmissão. */
  readonly maxPeers: number;
  /** Só chega nos dois motivos que pedem ação humana. */
  readonly onRecarregar?: () => void;
  readonly diagnostico?: ReactNode;
};

/**
 * A sala de espera do espectador. Estado, não erro.
 *
 * Esta é a primeira tela — muitas vezes a única por vários minutos — que o
 * amigo vê depois de clicar no link. Ela precisa responder três perguntas em
 * ordem, e a hierarquia visual é essa ordem: em que canal eu caí, o que está
 * acontecendo, e o que eu faço agora.
 *
 * O slug é o herói porque é a resposta da primeira pergunta. Em monoespaçada
 * porque é um identificador: quem abriu o link errado precisa comparar
 * caractere por caractere, e mono é a única escolha que torna isso possível.
 *
 * Nada aqui é verde. O acento é do AO VIVO, e reusá-lo apagaria a única
 * diferença visual entre "esperando" e "no ar" — que é exatamente a
 * informação que esta tela existe para dar.
 */
export function OfflineState({
  slug,
  motivo = 'conectando',
  maxPeers,
  onRecarregar,
  diagnostico,
}: Props) {
  const { rotulo, corpo, tom, varrendo } = TEXTO[motivo](maxPeers);
  const cor = tom === 'warn' ? 'text-warn' : 'text-muted';

  return (
    <div className="flex min-h-dvh items-center justify-center px-5 py-10">
      {/*
        `min-h-dvh` e não `min-h-full`: altura percentual resolve contra a
        altura do pai, e um pai com `min-height` e altura automática vale
        zero — o centro colapsa para o topo. Contra a viewport não colapsa.
      */}
      <section
        role="status"
        aria-live="polite"
        className="animate-enter w-full max-w-[660px] overflow-hidden rounded-md border border-line bg-surface"
      >
        <Varredura ativa={varrendo} />

        <div className="flex min-h-[min(46vh,300px)] flex-col items-center justify-center gap-5 px-6 py-12 text-center">
          <p className={`text-[11px] font-semibold uppercase tracking-[0.16em] ${cor}`}>
            {rotulo}
          </p>

          <h1 className="tabular max-w-full truncate text-[clamp(26px,6.5vw,42px)] font-medium leading-none text-text">
            {slug}
          </h1>

          <p className="max-w-[46ch] text-[13.5px] leading-relaxed text-muted">{corpo}</p>

          {onRecarregar && (
            <button
              type="button"
              onClick={onRecarregar}
              className="mt-1 inline-flex h-11 items-center rounded-sm border border-edge px-5 text-[13px] font-medium text-text transition-colors duration-150 hover:bg-void"
            >
              Recarregar a página
            </button>
          )}
        </div>
        {diagnostico}
      </section>
    </div>
  );
}

/**
 * A faixa é o único movimento desta tela, e ele carrega informação.
 *
 * Varrendo: o canal continua escutando sozinho e não há nada a fazer.
 * Parada e âmbar: a tentativa travou e depende de alguém.
 *
 * Um spinner comunicaria "está demorando demais", que é a leitura errada para
 * quem simplesmente chegou antes do jogo começar.
 *
 * Sob `prefers-reduced-motion` a faixa congela. Nenhuma informação se perde:
 * o rótulo e a cor já dizem o mesmo em texto.
 */
function Varredura({ ativa }: { readonly ativa: boolean }) {
  if (!ativa) return <div className="h-[2px] w-full bg-warn/60" aria-hidden="true" />;

  return (
    <div className="relative h-[2px] w-full overflow-hidden bg-line" aria-hidden="true">
      {/*
        Segmento curto e claro, não largo e apagado: numa faixa de 2px por 660
        de largura um degradê suave sobre um terço vira borrão de canto — lido
        como falha de renderização, não como intenção.
      */}
      <span className="animate-scan absolute inset-y-0 w-1/5 bg-gradient-to-r from-transparent via-text to-transparent" />
    </div>
  );
}

type Conteudo = {
  readonly rotulo: string;
  readonly corpo: string;
  readonly tom: 'muted' | 'warn';
  readonly varrendo: boolean;
};

/**
 * Um motivo por ação do leitor, não por código de erro.
 *
 * Quem lê "aguardando" não faz nada; quem lê "sem servidor" mexe no navegador.
 * Fundir os dois num "não deu" mandaria a pessoa agir quando ela só precisa
 * esperar — ou esperar quando nada vai acontecer sozinho.
 */
const TEXTO: Record<Motivo, (maxPeers: number) => Conteudo> = {
  conectando: () => ({
    rotulo: 'conectando',
    corpo: 'Procurando a transmissão e negociando a conexão direta.',
    tom: 'muted',
    varrendo: true,
  }),
  offline: () => ({
    rotulo: 'aguardando sinal',
    corpo: 'Deixe esta aba aberta. O vídeo começa sozinho, sem precisar atualizar.',
    tom: 'muted',
    varrendo: true,
  }),
  reconectando: () => ({
    rotulo: 'reconectando',
    corpo: 'O vídeo parou de chegar. Retomamos sozinhos assim que o sinal voltar.',
    tom: 'warn',
    varrendo: true,
  }),
  cheio: (maxPeers) => ({
    rotulo: `sem vaga · ${maxPeers}/${maxPeers}`,
    corpo: `Esta transmissão comporta ${maxPeers} pessoas ao mesmo tempo. Você entra sozinho quando alguém sair.`,
    tom: 'muted',
    varrendo: true,
  }),
  'sem-conexao': () => ({
    rotulo: 'sem rota',
    corpo:
      'A transmissão está no ar, mas o vídeo não conseguiu atravessar a rede. Vamos tentar novamente.',
    tom: 'warn',
    varrendo: false,
  }),
  'relay-indisponivel': () => ({
    rotulo: 'rota alternativa indisponível',
    corpo: 'O serviço que ajuda a conectar redes restritas está indisponível agora. A conexão direta também não fechou. Vamos tentar novamente.',
    tom: 'warn',
    varrendo: false,
  }),
  'relay-nao-configurado': () => ({
    rotulo: 'sem rota alternativa',
    corpo: 'Esta transmissão não tem uma rota alternativa configurada, e a conexão direta não fechou. Vamos tentar novamente.',
    tom: 'warn',
    varrendo: false,
  }),
  'sem-servidor': () => ({
    rotulo: 'sem servidor',
    corpo:
      'Não foi possível abrir a conexão. No Brave, desligue os escudos para este site: eles bloqueiam o endereço da transmissão. Extensão de privacidade e proxy de rede também derrubam.',
    tom: 'warn',
    varrendo: false,
  }),
};
