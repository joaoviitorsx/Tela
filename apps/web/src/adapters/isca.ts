/**
 * A isca do "um encode, N envios" (D0b) e do repassador (ADR 0031): uma trilha
 * 160×90 que emite UM quadro por `tique()`. Cada quadro dela é uma vaga onde o
 * worker de injeção troca o conteúdo pelo quadro real.
 *
 * # Por que não é mais um canvas
 *
 * Era um canvas fora da página com `captureStream(0)` e `requestFrame()`. O
 * Chromium só produz o quadro de um canvas no ciclo de renderização da página
 * — e esse ciclo para quando a aba fica escondida ou a janela minimizada, que
 * é EXATAMENTE como a web é usada: quem transmite está jogando em tela cheia,
 * com o navegador atrás. Sem quadro de isca não há vaga, e quem assiste via
 * slide (relato de 02/10: "a transmissão parece estar em slides").
 *
 * # Por que estática
 *
 * A primeira versão era um clone da captura, encolhido. Medido: ~3
 * quadros-chave por segundo na isca, sem PLI nenhum — a detecção de troca de
 * cena do encoder via o movimento do jogo, o worker lia a chave como pedido do
 * espectador e o codificador único soltava IDR: 112 em 60 s, espectador a
 * 20 fps. Estática, ela não tem cena para trocar.
 *
 * `MediaStreamTrackGenerator` recebe `VideoFrame` escrito pelo código: não
 * depende de pintura, nem de aba visível. O canvas fica como reserva para o
 * navegador que não tem o gerador.
 */
export type Isca = { readonly trilha: MediaStreamTrack; readonly tique: () => void };

const L = 160;
const A = 90;

type Gerador = MediaStreamTrack & { readonly writable: WritableStream<VideoFrame> };
type ConstrutorDeGerador = new (init: { kind: 'video' }) => Gerador;

export function criarIsca(): Isca {
  const Construtor = (globalThis as { MediaStreamTrackGenerator?: ConstrutorDeGerador }).MediaStreamTrackGenerator;
  if (typeof Construtor === 'function' && typeof VideoFrame === 'function') {
    try {
      return iscaGerada(Construtor);
    } catch {
      // Gerador que existe mas recusa (contexto sem suporte): vai de canvas.
    }
  }
  return iscaDeCanvas();
}

function iscaGerada(Construtor: ConstrutorDeGerador): Isca {
  const trilha = new Construtor({ kind: 'video' });
  trilha.contentHint = 'motion';
  const escritor = trilha.writable.getWriter();
  // I420 cinza-escuro. Um pixel alterna a cada quadro: quadro idêntico pode
  // ser tratado como repetido no caminho do encoder.
  const quadro = new Uint8Array((L * A * 3) / 2);
  quadro.fill(16, 0, L * A);
  quadro.fill(128, L * A);
  let par = false;
  let ocupado = false;
  return {
    trilha,
    tique: () => {
      // Escrita ainda pendente: esta vaga não sai. Nunca acumula fila aqui.
      if (ocupado) return;
      par = !par;
      quadro[0] = par ? 16 : 17;
      const vf = new VideoFrame(quadro, {
        format: 'I420',
        codedWidth: L,
        codedHeight: A,
        timestamp: Math.round(performance.now() * 1000),
      });
      ocupado = true;
      escritor.write(vf).then(
        () => {
          ocupado = false;
        },
        () => {
          ocupado = false;
          vf.close();
        },
      );
    },
  };
}

function iscaDeCanvas(): Isca {
  const canvas = document.createElement('canvas');
  canvas.width = L;
  canvas.height = A;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) throw new Error('canvas 2D indisponível para a isca');
  ctx.fillStyle = '#101010';
  ctx.fillRect(0, 0, L, A);
  const trilha = canvas.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (trilha === undefined) throw new Error('isca sem trilha');
  trilha.contentHint = 'motion';
  let par = false;
  return {
    trilha,
    tique: () => {
      par = !par;
      ctx.fillStyle = par ? '#101010' : '#111111';
      ctx.fillRect(0, 0, 1, 1);
      trilha.requestFrame();
    },
  };
}
