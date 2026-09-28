import type { ReactNode } from 'react';
import { Botao } from './Botao.js';
import { Led } from './Led.js';
import { Marca } from './Marca.js';

export type Motivo =
  | 'conectando'
  | 'offline'
  | 'reconectando'
  | 'cheio'
  | 'sem-conexao'
  | 'sem-video'
  | 'relay-indisponivel'
  | 'relay-nao-configurado'
  | 'sem-servidor'
  | 'convite-ausente'
  | 'convite-invalido'
  | 'removido'
  | 'desatualizado';

type Props = {
  readonly slug: string;
  readonly motivo?: Motivo;
  /** Vem da rota: o componente não inventa o limite da transmissão. */
  readonly maxPeers: number;
  /**
   * Onde a conexão está, só para `conectando`. A rota traduz o estado real da
   * sessão (`checking`, `connecting`) — os blocos não avançam por relógio.
   */
  readonly etapa?: 'procurando' | 'negociando';
  /** Só chega nos motivos que pedem ação humana. */
  readonly onTentarNovamente?: () => void;
  readonly diagnostico?: ReactNode;
};

const ETAPAS = {
  procurando: { texto: 'procurando o canal…', blocos: 3 },
  negociando: { texto: 'negociando a conexão direta…', blocos: 8 },
} as const;

/**
 * A sala de espera do espectador, como a tela de um televisor sem sinal.
 *
 * Esta é a primeira tela — muitas vezes a única por vários minutos — que o
 * amigo vê depois de clicar no link. Ela responde três perguntas em ordem, e a
 * hierarquia é essa ordem: em que canal eu caí (o slug, em numeral grande e em
 * monoespaçada: quem abriu o link errado precisa comparar letra a letra), o que
 * está acontecendo, e o que eu faço agora.
 *
 * # Estado, não erro
 *
 * Cor e glifo dizem a mesma coisa que o texto: o "!" e o âmbar marcam o que
 * depende de alguém; o LED piscando marca o que se resolve sozinho. Nada é só
 * cor. O chiado é estático, salvo em `conectando`, que dura segundos — uma tela
 * de espera que fica horas aberta não pode animar a tela inteira.
 */
export function OfflineState({
  slug,
  motivo = 'conectando',
  maxPeers,
  etapa = 'procurando',
  onTentarNovamente,
  diagnostico,
}: Props) {
  const { rotulo, corpo, tom, espera } = TEXTO[motivo](maxPeers);
  const sintonizando = motivo === 'conectando';

  return (
    <div
      className={[
        'relative flex min-h-dvh items-center justify-center px-4 py-10',
        sintonizando ? 'chiado-suave chiado-anda' : 'chiado-suave',
      ].join(' ')}
    >
      <div className="absolute left-4 top-4 sm:left-6 sm:top-5">
        <Marca tamanho="pequeno" />
      </div>

      <section
        role="status"
        aria-live="polite"
        className="acima-do-crt entra w-full max-w-[680px] overflow-hidden border-2 border-edge bg-[rgb(8_8_10_/_0.94)] shadow-[0_0_0_2px_#000]"
      >
        <div className="flex flex-col items-center gap-5 px-5 py-9 text-center sm:px-8 sm:py-11">
          <p
            className={[
              'flex items-center gap-2.5 font-[family-name:var(--font-pixel)] text-[13px]',
              tom === 'alerta' ? 'text-accent-hi' : 'text-muted',
            ].join(' ')}
          >
            {tom === 'alerta' ? <span aria-hidden="true">!</span> : espera ? <Led cor="ok" pisca /> : null}
            <span>{sintonizando ? `sintonizando` : rotulo}</span>
          </p>

          <h1 className="numeral m-0 max-w-full truncate text-[clamp(38px,9vw,64px)] text-accent-hi [text-shadow:0_0_18px_rgb(242_169_59_/_0.4)]">
            <span className="text-dim">tela.gg/</span>
            {slug}
          </h1>

          {sintonizando ? (
            <>
              <div aria-hidden="true" className="flex gap-1">
                {Array.from({ length: 12 }, (_, i) => (
                  <span
                    key={i}
                    className={`h-3.5 w-3.5 bg-accent ${i < ETAPAS[etapa].blocos ? 'opacity-100' : 'opacity-15'}`}
                  />
                ))}
              </div>
              <p className="m-0 text-[12px] text-muted">{ETAPAS[etapa].texto}</p>
              <p className="sr-only">{rotulo}</p>
            </>
          ) : (
            <p className="m-0 max-w-[46ch] text-[12.5px] leading-relaxed text-muted [text-wrap:pretty]">
              {corpo}
            </p>
          )}

          {onTentarNovamente && (
            <Botao tom="primaria" onClick={onTentarNovamente}>
              TENTAR NOVAMENTE
            </Botao>
          )}
        </div>
        {diagnostico}
      </section>
    </div>
  );
}

type Conteudo = {
  readonly rotulo: string;
  readonly corpo: string;
  readonly tom: 'muted' | 'alerta';
  /** Se resolve sozinho: mostra o LED piscando, "estou escutando". */
  readonly espera: boolean;
};

/**
 * Um motivo por ação do leitor, não por código de erro.
 *
 * Quem lê "aguardando" não faz nada; quem lê "sem servidor" mexe no navegador.
 * Fundir os dois num "não deu" mandaria a pessoa agir quando ela só precisa
 * esperar — ou esperar quando nada vai acontecer sozinho.
 *
 * Os `rotulo` de `offline`, `conectando`, `cheio`, `convite-*` são os que o E2E
 * (`e2e/mesh.e2e.mjs`) procura no texto da página. Não mude sem mudar lá.
 */
const TEXTO: Record<Motivo, (maxPeers: number) => Conteudo> = {
  conectando: () => ({
    rotulo: 'conectando',
    corpo: 'Procurando a transmissão e negociando a conexão direta.',
    tom: 'muted',
    espera: true,
  }),
  offline: () => ({
    rotulo: 'aguardando sinal',
    corpo: 'Deixe esta aba aberta. O vídeo começa sozinho, sem precisar atualizar.',
    tom: 'muted',
    espera: true,
  }),
  reconectando: () => ({
    rotulo: 'reconectando',
    corpo: 'O vídeo parou de chegar. Retomamos sozinhos assim que o sinal voltar.',
    tom: 'alerta',
    espera: true,
  }),
  cheio: (maxPeers) => ({
    rotulo: `sem vaga · ${maxPeers}/${maxPeers}`,
    corpo: `Esta transmissão comporta ${maxPeers} pessoas ao mesmo tempo. Você entra sozinho quando alguém sair.`,
    tom: 'muted',
    espera: true,
  }),
  /*
    Os dois textos abaixo afirmam só o que foi comprovado. "Sem rota" dizia
    saber a causa quando só se sabia o efeito.
  */
  'sem-conexao': () => ({
    rotulo: 'sem conexão',
    corpo:
      'Não conseguimos receber a transmissão nesta rede. Ela está no ar, e seguimos tentando.',
    tom: 'alerta',
    espera: false,
  }),
  'sem-video': () => ({
    rotulo: 'conectado, sem vídeo',
    corpo:
      'Conectamos, mas o vídeo ainda não chegou. A rede não é o problema aqui; seguimos tentando.',
    tom: 'alerta',
    espera: false,
  }),
  'relay-indisponivel': () => ({
    rotulo: 'rota alternativa indisponível',
    corpo:
      'O serviço que ajuda a conectar redes restritas está indisponível agora. A conexão direta também não fechou. Vamos tentar novamente.',
    tom: 'alerta',
    espera: false,
  }),
  'relay-nao-configurado': () => ({
    rotulo: 'sem rota alternativa',
    corpo:
      'Esta transmissão não tem uma rota alternativa configurada, e a conexão direta não fechou. Vamos tentar novamente.',
    tom: 'alerta',
    espera: false,
  }),
  'convite-ausente': () => ({
    rotulo: 'link incompleto',
    corpo:
      'Este link não traz o convite da transmissão. Peça o link de novo a quem está transmitindo e cole ele inteiro, com a parte depois do #.',
    tom: 'alerta',
    espera: false,
  }),
  'convite-invalido': () => ({
    rotulo: 'convite renovado',
    corpo: 'Quem transmite renovou o convite, e este link não abre mais a sala. Peça o link novo.',
    tom: 'alerta',
    espera: false,
  }),
  removido: () => ({
    rotulo: 'desconectado',
    corpo: 'Quem está transmitindo encerrou seu acesso a esta transmissão.',
    tom: 'alerta',
    espera: false,
  }),
  desatualizado: () => ({
    rotulo: 'página desatualizada',
    corpo: 'O Tela foi atualizado desde que esta página abriu. Recarregue para entrar.',
    tom: 'alerta',
    espera: false,
  }),
  'sem-servidor': () => ({
    rotulo: 'sem servidor',
    corpo:
      'Não foi possível abrir a conexão. No Brave, desligue os escudos para este site: eles bloqueiam o endereço da transmissão. Extensão de privacidade e proxy de rede também derrubam.',
    tom: 'alerta',
    espera: false,
  }),
};
