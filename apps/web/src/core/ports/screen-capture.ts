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

export type CaptureError = 'DENIED' | 'UNSUPPORTED' | 'NO_TRACK';

export type ScreenCapture = {
  isSupported(): boolean;
  /** Rejeita com `CaptureError`; o usuário cancelar o seletor é `DENIED`, não bug. */
  request(options: CaptureRequest): Promise<CaptureResult>;
};
