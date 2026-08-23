export type CaptureRequest = {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  /** Windows/Chrome entrega áudio do sistema junto; Linux e macOS, não (§10). */
  readonly systemAudio: boolean;
};

export type CaptureResult = {
  readonly video: MediaStreamTrack;
  readonly audio: MediaStreamTrack | null;
};

export type CaptureError = 'DENIED' | 'UNSUPPORTED' | 'NO_TRACK';

export type ScreenCapture = {
  isSupported(): boolean;
  /** Rejeita com `CaptureError`; o usuário cancelar o picker é `DENIED`, não bug. */
  request(options: CaptureRequest): Promise<CaptureResult>;
};
