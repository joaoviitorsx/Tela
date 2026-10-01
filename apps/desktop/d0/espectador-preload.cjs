/**
 * Só para o D0: guarda as RTCPeerConnection que a página do espectador cria,
 * para o harness ler o `inbound-rtp` (quadros decodificados, congelamentos,
 * pedidos de quadro-chave). Roda no mundo da página porque o espectador do
 * harness abre sem contextIsolation — nunca no app.
 */
const Original = window.RTCPeerConnection;
window.__pcs = [];
window.RTCPeerConnection = class extends Original {
  constructor(...a) {
    super(...a);
    window.__pcs.push(this);
  }
};
