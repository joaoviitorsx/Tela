import type { CandidatoVisto, SondaDeRede } from '../core/ports/sonda-de-rede.js';

/**
 * Os mesmos STUN públicos que o signaling entrega por padrão. Dois, e de
 * operadores diferentes: é a comparação entre eles que revela NAT simétrico.
 */
const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const PRAZO_MS = 5_000;

/**
 * Coleta ICE contra os dois STUN pela MESMA conexão, sem mídia e sem
 * sinalização. Uma conexão só de propósito: cada `RTCPeerConnection` abre
 * sockets próprios, e comparar portas públicas entre conexões diferentes
 * confunde "saídas diferentes" com "NAT simétrico" (ver `sonda-de-rede.ts`).
 * Nada sai daqui além de tipos e portas — IP nenhum é guardado.
 */
export function makeBrowserSondaDeRede(): SondaDeRede {
  return {
    async testar(aoProgresso) {
      if (typeof RTCPeerConnection === 'undefined') {
        return { candidatos: [], primeiraRespostaMs: null, erro: 'NotSupportedError' };
      }
      const inicio = performance.now();
      let primeira: number | null = null;
      const candidatos: CandidatoVisto[] = [];
      const relogio = window.setInterval(() => {
        aoProgresso(Math.min(0.95, (performance.now() - inicio) / PRAZO_MS));
      }, 150);

      const pc = new RTCPeerConnection({ iceServers: STUN.map((urls) => ({ urls })) });
      try {
        pc.createDataChannel('sonda');
        const terminou = new Promise<void>((resolve) => {
          const prazo = window.setTimeout(resolve, PRAZO_MS);
          pc.onicecandidate = (e) => {
            if (e.candidate === null) {
              window.clearTimeout(prazo);
              resolve();
              return;
            }
            const tipo = e.candidate.type ?? 'desconhecido';
            if (tipo === 'srflx' && primeira === null) primeira = Math.round(performance.now() - inicio);
            candidatos.push({ tipo, portaPublica: tipo === 'srflx' ? (e.candidate.port ?? null) : null });
          };
        });
        await pc.setLocalDescription(await pc.createOffer());
        await terminou;
        return { candidatos, primeiraRespostaMs: primeira, erro: null };
      } catch (erro) {
        return { candidatos, primeiraRespostaMs: primeira, erro: erro instanceof Error ? erro.name : 'Error' };
      } finally {
        pc.close();
        window.clearInterval(relogio);
        aoProgresso(1);
      }
    },
  };
}
