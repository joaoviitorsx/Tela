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
  | { readonly tipo: 'atraso'; readonly quadros: number };

type QuadroIsca = {
  readonly type: 'key' | 'delta' | 'empty';
  data: ArrayBuffer;
  getMetadata(): Record<string, unknown>;
  setMetadata?(metadata: Record<string, unknown>): void;
};

type Transformer = {
  readonly readable: ReadableStream<QuadroIsca>;
  readonly writable: WritableStream<QuadroIsca>;
  readonly options: { readonly id?: string };
};

type Escopo = {
  onmessage: ((e: MessageEvent<{ tipo: 'porta'; porta: MessagePort }>) => void) | null;
  onrtctransform: ((e: { readonly transformer: Transformer }) => void) | null;
};

const escopo = self as unknown as Escopo;
const fila = new FilaDeInjecao<ChunkInjetado>(() => performance.now());
const ultimoTamanho = { width: 0, height: 0 };
let porta: MessagePort | null = null;

function avisar(aviso: AvisoDoWorker): void {
  porta?.postMessage(aviso);
}

// Contrapressão: o codificador pula quadro de conteúdo enquanto houver fila.
setInterval(() => avisar({ tipo: 'atraso', quadros: fila.atraso() }), 100);

escopo.onmessage = (e) => {
  if (e.data?.tipo !== 'porta') return;
  porta = e.data.porta;
  porta.onmessage = (m: MessageEvent<ChunkInjetado>) => {
    const c = m.data;
    ultimoTamanho.width = c.width;
    ultimoTamanho.height = c.height;
    fila.chegou({ seq: c.seq, chave: c.chave, dados: c });
  };
};

escopo.onrtctransform = ({ transformer }) => {
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
      if (quadro.type === 'key' && vistos > 1) {
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
      if (typeof quadro.setMetadata === 'function') {
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
