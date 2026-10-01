/**
 * Só para o D0c: o preload do espectador (guarda as RTCPeerConnection) mais a
 * porta do `tela-captura`, que o processo principal entrega por IPC. Roda no
 * mundo da página porque o host do harness abre sem contextIsolation — nunca
 * no app.
 */
const { ipcRenderer } = require('electron');

const Original = window.RTCPeerConnection;
window.__pcs = [];
window.RTCPeerConnection = class extends Original {
  constructor(...a) {
    super(...a);
    window.__pcs.push(this);
  }
};
ipcRenderer.on('captura-nativa', (e) => {
  window.__portaNativa = e.ports[0];
});
