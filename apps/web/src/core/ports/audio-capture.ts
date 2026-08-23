export type AudioDevice = { readonly id: string; readonly label: string };

/**
 * Só existe por causa do Linux: o Chrome não entrega áudio do sistema via
 * getDisplayMedia lá, então o usuário roteia o jogo para um sink virtual e
 * nós capturamos o monitor dele como se fosse microfone (§10).
 */
export type AudioCapture = {
  /** Candidatos a monitor de sink virtual, já filtrados. */
  listMonitors(): Promise<AudioDevice[]>;
  capture(deviceId: string): Promise<MediaStreamTrack>;
};
