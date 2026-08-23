export type AudioDevice = { readonly id: string; readonly label: string };

/**
 * Só existe por causa do Linux.
 *
 * No Windows o Chrome entrega o áudio do sistema junto com a tela, e este port
 * nem é usado. No Linux ele não entrega — só áudio de aba — então o jogo
 * nativo sai mudo. A saída é rotear o jogo para um sink virtual e capturar o
 * monitor dele como se fosse microfone.
 */
export type AudioCapture = {
  /**
   * Pede permissão de áudio ao browser.
   *
   * Necessário ANTES de listar: sem permissão concedida, `enumerateDevices`
   * devolve dispositivos sem rótulo, e "Monitor of TelaCapture" vira uma
   * string vazia que o usuário não consegue escolher.
   */
  requestPermission(): Promise<boolean>;

  /** Candidatos a monitor de sink virtual, já filtrados. */
  listMonitors(): Promise<AudioDevice[]>;

  capture(deviceId: string): Promise<MediaStreamTrack>;
};
