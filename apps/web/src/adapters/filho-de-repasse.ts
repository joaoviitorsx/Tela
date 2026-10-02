import type { IceServerConfig } from '@tela/shared';
import { type ReferenciaDeCaptura, paraUnixMs } from '../core/media/relogio-de-captura.js';
import { JITTER_INICIAL_MS, PeerLink } from '../core/mesh/peer-link.js';
import { VigiaDoPai } from '../core/mesh/vigia-do-pai.js';
import type { ComPai, SemPai } from '../core/mesh/protocolo-de-repasse.js';

/**
 * O espectador cujo vídeo vem de um repassador (ADR 0031, fase 1).
 *
 * A ligação com o anfitrião continua de pé: o áudio vem de lá, e é o caminho
 * de volta se o pai falhar. A troca é sempre "com rede de proteção":
 *
 * 1. o anfitrião manda `pai`; esta classe liga no pai e espera a imagem;
 * 2. o primeiro quadro DECODIFICADO do pai troca a trilha de vídeo da tela e
 *    manda `com-pai` — só aí o anfitrião pausa o vídeo direto;
 * 3. imagem do pai parada por mais que `VIGIA_MS`, a ligação caindo, ou o
 *    filho decodificando bem menos do que o pai recebe (`VigiaDoPai`): volta
 *    à trilha do anfitrião e manda `sem-pai`, e o anfitrião retoma.
 */
export type DepsDoFilho = {
  readonly createConnection: (config: RTCConfiguration) => RTCPeerConnection;
  readonly iceServers: () => readonly IceServerConfig[];
  readonly enviarVia: (para: string, dados: unknown) => void;
  readonly enviar: (mensagem: ComPai | SemPai) => void;
  /** A trilha de vídeo da tela: a do pai, ou `null` para voltar à do anfitrião. */
  readonly aoTrocarVideo: (trilha: MediaStreamTrack | null) => void;
};

/**
 * Quanto a imagem do pai pode ficar parada antes de voltar ao anfitrião. A
 * ADR estima ~500 ms para detectar; um pouco acima, para um soluço de Wi-Fi
 * não virar troca de fonte.
 */
export const VIGIA_MS = 700;
/** De quanto em quanto tempo o filho olha se o primeiro quadro do pai já decodificou. */
const ESPERA_DO_PRIMEIRO_QUADRO_MS = 150;
/** De quanto em quanto tempo o filho compara o que decodifica com o que o pai recebe. */
const LEITURA_MS = 1_000;

export class FilhoDeRepasse {
  private pai: string | null = null;
  private link: PeerLink | null = null;
  private trilha: MediaStreamTrack | null = null;
  private vigia: ReturnType<typeof setTimeout> | null = null;
  /** O atraso que o quadro já trazia ao chegar no pai (ver `AtrasoDoPai`). */
  private atrasoDoPai: number | null = null;
  /**
   * O alvo de jitter que a sessão decidiu. Vale para a aresta do pai também:
   * sem isto ela ficava no valor inicial (60 ms) enquanto a ligação com o
   * anfitrião descia — 20 ms a mais de latência só por estar num filho.
   */
  private jitterAlvo = JITTER_INICIAL_MS;
  private readonly vigiaDoPai = new VigiaDoPai();
  /** Espera do primeiro quadro, ou leitura periódica da aresta: um relógio só. */
  private relogio: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DepsDoFilho) {}

  /** O vídeo na tela é o do pai (e a latência medida não é a do anfitrião). */
  get ativo(): boolean {
    return this.trilha !== null;
  }

  get paiAtual(): string | null {
    return this.pai;
  }

  definirPai(pai: string | null): void {
    if (pai === this.pai) return;
    this.soltar();
    if (pai === null) return;
    this.pai = pai;
    const link = new PeerLink({
      peerId: pai,
      polite: true,
      iceServers: this.deps.iceServers(),
      send: (payload) => this.deps.enviarVia(pai, payload),
      createConnection: this.deps.createConnection,
      onTrack: (track) => {
        if (track.kind !== 'video') return;
        link.setJitterAlvo(this.jitterAlvo);
        // A imagem do pai só vai para a tela — e o anfitrião só para de mandar
        // direto — depois do primeiro quadro DECODIFICADO, não do primeiro
        // pacote (ver `vigia-do-pai.ts`). Até lá a tela segue com o anfitrião.
        const assumir = () => {
          if (this.link !== link || this.trilha !== null) return;
          this.trilha = track;
          this.deps.aoTrocarVideo(track);
          this.deps.enviar({ repasse: 'com-pai' });
          this.vigiar(link);
        };
        this.pararRelogio();
        this.relogio = setInterval(() => {
          void decodificados(link).then((n) => {
            if (this.link !== link || this.trilha !== null || n === null) return;
            if (VigiaDoPai.pronto({ decodificados: n, agora: Date.now() })) {
              this.pararRelogio();
              assumir();
            }
          });
        }, ESPERA_DO_PRIMEIRO_QUADRO_MS);
        track.addEventListener('mute', () => {
          if (this.link !== link || this.trilha !== track) return;
          this.vigia ??= setTimeout(() => {
            this.vigia = null;
            if (track.muted) this.falhar();
          }, VIGIA_MS);
        });
        track.addEventListener('unmute', () => {
          if (this.vigia !== null) clearTimeout(this.vigia);
          this.vigia = null;
        });
        track.addEventListener('ended', () => {
          if (this.link === link) this.falhar();
        });
      },
      onStateChange: (state) => {
        if (this.link === link && (state === 'failed' || state === 'closed')) this.falhar();
      },
      onIssue: (code) => console.warn('[repasse]', code),
      onFatal: () => {
        if (this.link === link) this.falhar();
      },
    });
    this.link = link;
  }

  setJitterAlvo(ms: number): void {
    this.jitterAlvo = ms;
    this.link?.setJitterAlvo(ms);
  }

  sinal(de: string, dados: unknown): void {
    if (de !== this.pai) return;
    const relato = dados as { atrasoDoPaiMs?: unknown; fpsDoPai?: unknown } | null;
    if (relato !== null && typeof relato === 'object' && ('atrasoDoPaiMs' in relato || 'fpsDoPai' in relato)) {
      const atraso = relato.atrasoDoPaiMs;
      if (typeof atraso === 'number' && Number.isFinite(atraso) && atraso >= 0 && atraso <= 10_000) {
        this.atrasoDoPai = atraso;
      }
      const fps = relato.fpsDoPai;
      if (typeof fps === 'number' && Number.isFinite(fps) && fps >= 0 && fps <= 240) {
        this.vigiaDoPai.relatoDoPai(fps, Date.now());
      }
      return;
    }
    void this.link?.handleSignal(dados).catch(() => this.falhar());
  }

  /**
   * A referência de captura vista do filho: o carimbo da isca do pai, recuado
   * pelo atraso que o quadro já tinha ao chegar lá. Sem esse número, `null` —
   * melhor nenhum HUD que uma latência que esconde um salto.
   */
  async referenciaDeCaptura(): Promise<ReferenciaDeCaptura | null> {
    const atraso = this.atrasoDoPai;
    if (this.trilha === null || atraso === null) return null;
    const ref = (await this.link?.referenciaDeCaptura()) ?? null;
    if (ref === null) return null;
    return { ...ref, captureTimestamp: paraUnixMs(ref.captureTimestamp) - atraso };
  }

  stats(): Promise<RTCStatsReport> | null {
    return this.trilha === null ? null : (this.link?.stats() ?? null);
  }

  fechar(): void {
    this.soltar();
  }

  /** Com a imagem do pai na tela: a cada segundo, ela ainda acompanha a origem? */
  private vigiar(link: PeerLink): void {
    this.pararRelogio();
    this.vigiaDoPai.reiniciar();
    this.relogio = setInterval(() => {
      void decodificados(link).then((n) => {
        if (this.link !== link || n === null) return;
        if (this.vigiaDoPai.observar({ decodificados: n, agora: Date.now() })) this.falhar();
      });
    }, LEITURA_MS);
  }

  private pararRelogio(): void {
    if (this.relogio !== null) clearInterval(this.relogio);
    this.relogio = null;
  }

  /** A imagem do pai parou: volta ao anfitrião e avisa. */
  private falhar(): void {
    if (this.pai === null) return;
    this.soltar();
    this.deps.enviar({ repasse: 'sem-pai' });
  }

  private soltar(): void {
    if (this.vigia !== null) clearTimeout(this.vigia);
    this.vigia = null;
    this.pararRelogio();
    this.vigiaDoPai.reiniciar();
    const usava = this.trilha !== null;
    this.trilha = null;
    this.link?.close();
    this.link = null;
    this.pai = null;
    this.atrasoDoPai = null;
    if (usava) this.deps.aoTrocarVideo(null);
  }
}

/** Quadros de vídeo decodificados na aresta, acumulado; `null` sem leitura. */
async function decodificados(link: PeerLink): Promise<number | null> {
  try {
    let n: number | null = null;
    (await link.stats()).forEach((s: { type?: string; kind?: string; framesDecoded?: number }) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video' && typeof s.framesDecoded === 'number') n = s.framesDecoded;
    });
    return n;
  } catch {
    return null;
  }
}
