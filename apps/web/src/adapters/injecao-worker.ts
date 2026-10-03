/**
 * Worker do "um encode, N envios" (D0b). Um só para todos os senders de vídeo.
 *
 * Cada sender WebRTC codifica uma isca minúscula; aqui, cada quadro-isca recebe
 * o conteúdo do próximo quadro do codificador único — ou é descartado. A regra
 * da troca é a `FilaDeInjecao` (pura, testada); este arquivo só a liga às APIs
 * de Encoded Transform e à porta que vem do codificador.
 *
 * O spec proíbe mover quadros entre senders, mas o `data` de um quadro é
 * gravável: cada sender reescreve só os PRÓPRIOS quadros.
 */
import { FilaDeInjecao } from '../core/media/fila-de-injecao.js';

/** O que o codificador manda pela porta. */
export type ChunkInjetado = {
  readonly seq: number;
  readonly chave: boolean;
  readonly dados: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  /** Camada temporal do SVC L1T2 (ADR 0034), quando o encoder tem camadas. */
  readonly camada?: number;
};

/**
 * Do worker para o codificador. O motivo do pedido de chave decide a janela de
 * coalescência (`janelaDeChaveMs`): `entrada` é o primeiro IDR de um sender;
 * `pli` veio do espectador; `atrasado` é sender que ficou para trás da fila.
 * `senders` é a plateia vista daqui — o codificador escala a janela por ela.
 */
export type MotivoDeChave = 'pli' | 'entrada' | 'atrasado';
export type AvisoDoWorker =
  | { readonly tipo: 'chave'; readonly motivo: MotivoDeChave; readonly senders: number }
  | { readonly tipo: 'atraso'; readonly quadros: number }
  /** Espectadores soltos da contrapressão por ficarem para trás (ver `LIMITE_DE_ARRASTO`). */
  | { readonly tipo: 'arrasto'; readonly soltos: number }
  /** Repassador: hora de tocar a isca (relógio livre, ver `RELOGIO_DO_REPASSE_HZ`). */
  | { readonly tipo: 'tique' }
  /** Repassador: quadros copiados da recepção e vagas servidas, para o relatório. */
  | { readonly tipo: 'repasse'; readonly recebidos: number; readonly senders: number };

/**
 * Quem usa o worker. `anfitriao`: o codificador único manda os quadros pela
 * porta. `repassador` (ADR 0031): os quadros vêm do transform de RECEPÇÃO do
 * próprio espectador, e as vagas da isca batem num relógio do worker.
 */
export type PapelDoWorker = 'anfitriao' | 'repassador';

/** Do thread principal para o worker. */
export type MensagemAoWorker =
  | { readonly tipo: 'porta'; readonly porta: MessagePort; readonly papel?: PapelDoWorker }
  /** O sender parou de mandar (cascata): fora da fila, fora da contrapressão. */
  | { readonly tipo: 'pausa'; readonly id: string };

/**
 * O relógio da isca no repassador. O E2 (ADR 0031) mediu: acoplada à chegada,
 * a fila nunca drena (+130 a +275 ms por salto); livre a 60 Hz, ~+12 ms. Um
 * pouco acima dos 60 quadros da fonte para drenar a entrada com tolerância
 * (`toleranciaDeEntrada`) — e abaixo dos 120 Hz que, com 3 filhos, já
 * derrubavam o próprio repassador a 50 fps.
 */
export const RELOGIO_DO_REPASSE_HZ = 75;
/** Quantos quadros atrás da ponta o filho do repassador ainda pode entrar. */
const TOLERANCIA_DO_REPASSE = 4;

type QuadroIsca = {
  readonly type: 'key' | 'delta' | 'empty';
  data: ArrayBuffer;
  getMetadata(): Record<string, unknown>;
  setMetadata?(metadata: Record<string, unknown>): void;
};

type Transformer = {
  readonly readable: ReadableStream<QuadroIsca>;
  readonly writable: WritableStream<QuadroIsca>;
  readonly options: { readonly id?: string; readonly papel?: 'recepcao' };
};

type Escopo = {
  onmessage: ((e: MessageEvent<MensagemAoWorker>) => void) | null;
  onrtctransform: ((e: { readonly transformer: Transformer }) => void) | null;
};

const escopo = self as unknown as Escopo;
let fila = new FilaDeInjecao<ChunkInjetado>(() => performance.now());
const ultimoTamanho = { width: 0, height: 0 };
let porta: MessagePort | null = null;
let papel: PapelDoWorker = 'anfitriao';
let recebidos = 0;

function avisar(aviso: AvisoDoWorker): void {
  porta?.postMessage(aviso);
}

// Contrapressão: o codificador pula quadro de conteúdo enquanto houver fila.
// O repassador não tem codificador a segurar (ver o relógio dele abaixo).
setInterval(() => {
  if (papel !== 'anfitriao') return;
  // Antes do atraso: um caminho lento não pode segurar a sala inteira.
  const soltos = fila.soltarArrastados();
  if (soltos > 0) avisar({ tipo: 'arrasto', soltos });
  avisar({ tipo: 'atraso', quadros: fila.atraso() });
}, 100);

escopo.onmessage = (e) => {
  const m = e.data;
  if (m?.tipo === 'pausa') {
    fila.saiu(m.id);
    return;
  }
  if (m?.tipo !== 'porta') return;
  porta = m.porta;
  if (m.papel === 'repassador') {
    papel = 'repassador';
    fila = new FilaDeInjecao<ChunkInjetado>(() => performance.now(), { toleranciaDeEntrada: TOLERANCIA_DO_REPASSE });
    // Relógio livre: a vaga não espera a chegada (E2). No worker, e não no
    // thread da página, porque timer de aba em segundo plano é estrangulado.
    // Sem filho, nem relógio: o worker só deixa os quadros passarem.
    setInterval(() => {
      if (fila.senders() > 0) avisar({ tipo: 'tique' });
    }, 1000 / RELOGIO_DO_REPASSE_HZ);
    setInterval(() => {
      if (fila.senders() > 0) avisar({ tipo: 'repasse', recebidos, senders: fila.senders() });
    }, 1_000);
    // Filho que não acompanha pula para o próximo IDR em vez de ver câmera lenta.
    setInterval(() => {
      if (fila.senders() > 0) fila.soltarArrastados(false);
    }, 100);
    return;
  }
  porta.onmessage = (msg: MessageEvent<ChunkInjetado>) => {
    const c = msg.data;
    ultimoTamanho.width = c.width;
    ultimoTamanho.height = c.height;
    // Só 0 ou 1: qualquer outra coisa é "sem camadas", e a válvula não age.
    const camada = c.camada === 0 || c.camada === 1 ? c.camada : undefined;
    fila.chegou({ seq: c.seq, chave: c.chave, dados: c, ...(camada === undefined ? {} : { camada }) });
  };
};

/**
 * O `seq` da recepção é do worker, não de cada transform: uma ligação refeita
 * com o anfitrião traz um receiver novo, e recomeçar do zero colidiria com o
 * anel da fila.
 */
let seq = 0;

/**
 * Repassador: cada quadro que chega do anfitrião segue para o decoder daqui
 * intacto, e uma CÓPIA entra na fila dos filhos. Copiar só com filho na fila:
 * sem ninguém para servir, o custo é só a passagem. O filho que entra espera
 * um IDR de qualquer jeito.
 */
function repassarRecepcao(transformer: Transformer): void {
  const leitor = transformer.readable.getReader();
  const escritor = transformer.writable.getWriter();
  void (async () => {
    for (;;) {
      const { value: quadro, done } = await leitor.read();
      if (done || quadro === undefined) return;
      if (fila.senders() > 0 && quadro.type !== 'empty') {
        recebidos += 1;
        const chave = quadro.type === 'key';
        fila.chegou({
          seq,
          chave,
          // H.264 na recepção traz width/height 0 (E2): o filho lê o SPS.
          dados: { seq, chave, dados: quadro.data.slice(0), width: 0, height: 0 },
        });
        seq += 1;
      }
      await escritor.write(quadro);
    }
  })();
}

escopo.onrtctransform = ({ transformer }) => {
  if (transformer.options.papel === 'recepcao') {
    repassarRecepcao(transformer);
    return;
  }
  const id = transformer.options.id ?? crypto.randomUUID();
  fila.entrou(id);
  const leitor = transformer.readable.getReader();
  const escritor = transformer.writable.getWriter();
  let vistos = 0;
  // Por que este sender estaria esperando IDR: começa pela entrada; depois de
  // servido, só por PLI ou por ter ficado para trás.
  let motivo: MotivoDeChave = 'entrada';
  void (async () => {
    for (;;) {
      const { value: quadro, done } = await leitor.read();
      if (done || quadro === undefined) {
        fila.saiu(id);
        return;
      }
      vistos += 1;
      /*
        A isca tem parâmetros FIXOS (o transporte nunca os reconfigura), então
        quadro-chave nela depois do primeiro só nasce de PLI/FIR do espectador:
        é o pedido de quadro-chave dele, chegando por aqui.
      */
      // No repassador, não: a isca dele é reconfigurada (teto da aresta) e
      // cada reconfiguração gera uma chave que pararia o filho até o próximo
      // IDR periódico — e um filho quebrado de verdade espera esse mesmo IDR,
      // porque ninguém pede chave ao anfitrião por ele (ADR 0031).
      if (quadro.type === 'key' && vistos > 1 && papel === 'anfitriao') {
        fila.pediuChave(id);
        motivo = 'pli';
      }
      const decisao = fila.vaga(id);
      if (decisao.tipo === 'descartar') {
        if (decisao.pedirChave) avisar({ tipo: 'chave', motivo, senders: fila.senders() });
        continue;
      }
      motivo = 'atrasado';
      const real = decisao.quadro.dados;
      // Cópia por sender: um ArrayBuffer não pode ser de dois quadros.
      quadro.data = real.dados.slice(0);
      if (typeof quadro.setMetadata === 'function' && real.width > 0) {
        try {
          quadro.setMetadata({ ...quadro.getMetadata(), width: real.width, height: real.height });
        } catch {
          // Metadado é dica de cabeçalho; o decoder lê o SPS.
        }
      }
      await escritor.write(quadro);
    }
  })();
};
