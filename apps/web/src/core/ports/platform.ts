/**
 * O que muda entre sistemas operacionais, visto de dentro do núcleo.
 *
 * `core/` não olha `navigator.userAgent` — isso é detalhe de browser e mora
 * no adapter. O que o núcleo precisa saber é uma coisa só: **de onde vem o
 * áudio do jogo neste sistema**.
 */
export type SystemAudioMode =
  /** Windows + Chromium: `getDisplayMedia` devolve a trilha de áudio junto. */
  | 'display-media'
  /**
   * Linux: o Chrome não entrega áudio do sistema via `getDisplayMedia`, só
   * áudio de aba. Jogo nativo sai mudo. A saída é um sink virtual, capturado
   * como se fosse microfone.
   */
  | 'monitor-device'
  /** macOS: exige driver de terceiro (BlackHole, Loopback). Fora do escopo. */
  | 'unsupported';

export type Platform = {
  systemAudio(): SystemAudioMode;
  /** Nome legível do SO, só para a UI escrever a instrução certa. */
  osName(): 'windows' | 'linux' | 'macos' | 'desconhecido';
};
