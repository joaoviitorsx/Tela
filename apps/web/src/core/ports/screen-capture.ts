import type { Result } from '../domain/result.js';

export type CaptureRequest = {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  /** Windows/Chrome entrega áudio do sistema junto; Linux e macOS, não. */
  readonly systemAudio: boolean;
};

/**
 * O que o usuário acabou escolhendo no seletor do sistema.
 *
 * Importa porque muda o que ele vai receber: no Windows, o áudio do sistema
 * só acompanha a TELA INTEIRA. Quem escolhe uma janela transmite mudo — e o
 * browser não avisa. Saber a superfície é o que permite avisar por ele.
 */
export type CaptureSurface = 'monitor' | 'window' | 'browser' | 'desconhecido';

export type CaptureResult = {
  readonly video: MediaStreamTrack;
  readonly audio: MediaStreamTrack | null;
  readonly surface: CaptureSurface;
};

/**
 * Por que não veio captura — e a diferença muda o que a pessoa lê.
 *
 * `DENIED` é escolha dela: cancelou o seletor ou negou a permissão. `FAILED`
 * não é: o navegador ou o sistema não conseguiu entregar (outro programa
 * segurando a tela, portal do Wayland que caiu, captura sem trilha de vídeo).
 * Antes as duas viravam "você cancelou", e quem não tinha cancelado nada
 * ficava sem saber o que fazer.
 */
export type CaptureError = 'DENIED' | 'UNSUPPORTED' | 'FAILED';

export type ScreenCapture = {
  isSupported(): boolean;
  /**
   * Erro esperado é `Result`, não exceção (R4). Cancelar o seletor é fluxo
   * normal; `throw` fica para bug.
   */
  request(options: CaptureRequest): Promise<Result<CaptureResult, CaptureError>>;
};
