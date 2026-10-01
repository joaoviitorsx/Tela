/**
 * Worker do "um encode, N envios" (D0, caminho B).
 *
 * Cada `RTCRtpSender` de vídeo codifica uma trilha-isca minúscula; este worker
 * recebe os quadros-isca de TODOS os senders (um `rtctransform` por sender) e
 * troca o conteúdo de cada um pelo próximo quadro do encoder único, que chega
 * pela porta `chunks`. O spec proíbe mover quadros entre senders — então cada
 * sender só escreve os PRÓPRIOS quadros, com os bytes trocados.
 *
 * Regras de H.264 que este arquivo não pode quebrar:
 * - quadro P depende do anterior: nenhum chunk é pulado no meio de um GOP;
 * - quem entra (ou pede quadro-chave) só recebe a partir de um IDR;
 * - quadro-isca sem chunk novo é DESCARTADO, nunca enviado vazio.
 */
const RECENTES = 180; // ~3 s a 60 fps: o bastante para um sender atrasado alcançar
const recentes = []; // { seq, key, data, width, height }
const senders = new Set(); // estados vivos, para medir o atraso da fila
let ultimoSeq = -1;
let principal = null; // porta para pedir quadro-chave ao encoder

/**
 * Atraso da fila = quantos quadros codificados o sender mais atrasado ainda não
 * mandou. Cada vaga de isca leva no máximo UM quadro real; se uma vaga passa
 * vazia, o atraso sobe e não desce sozinho. O encoder lê este número e deixa de
 * codificar quadro enquanto há fila (contrapressão) — melhor perder um quadro de
 * conteúdo do que acumular latência.
 */
setInterval(() => {
  if (principal === null || senders.size === 0) return;
  let pior = 0;
  const agora = performance.now();
  for (const s of senders) {
    // Sender sem quadro há 1 s está morto (conexão fechada sem avisar o stream):
    // contá-lo travava a contrapressão e parava o encoder para todo mundo.
    if (agora - s.ultimoVisto > 1000) continue;
    if (!s.esperandoChave && s.proximo >= 0) pior = Math.max(pior, ultimoSeq + 1 - s.proximo);
  }
  principal.postMessage({ tipo: 'atraso', quadros: pior });
}, 100);

self.onmessage = (e) => {
  if (e.data?.tipo === 'porta') {
    principal = e.data.porta;
    principal.onmessage = (m) => {
      const c = m.data;
      recentes.push(c);
      ultimoSeq = c.seq;
      if (recentes.length > RECENTES) recentes.shift();
    };
  }
};

function pedirChave(motivo) {
  principal?.postMessage({ tipo: 'chave', motivo });
}

onrtctransform = (evento) => {
  const t = evento.transformer;
  const estado = { proximo: -1, esperandoChave: true, vistos: 0, enviados: 0, descartados: 0, ultimoVisto: performance.now() };
  senders.add(estado);
  pedirChave('sender-novo');
  const leitor = t.readable.getReader();
  const escritor = t.writable.getWriter();
  (async () => {
    for (;;) {
      const { value: quadro, done } = await leitor.read();
      if (done) {
        senders.delete(estado); // sender encerrado não conta no atraso
        return;
      }
      estado.vistos += 1;
      estado.ultimoVisto = performance.now();
      // O encoder-isca gerou chave = o espectador pediu (PLI) ou acabou de entrar.
      if (quadro.type === 'key' && estado.vistos > 1 && !estado.esperandoChave) {
        estado.esperandoChave = true;
        pedirChave('pli');
      }
      let chunk = null;
      if (estado.esperandoChave) {
        /*
          Só começa num IDR que esteja NA PONTA. Começar num IDR antigo deixava
          o sender preso N quadros atrás para sempre (cada vaga leva no máximo
          um quadro) — medido: 17 quadros, ~280 ms de latência a mais.
        */
        const ponta = recentes.at(-1);
        if (ponta !== undefined && ponta.key && ponta.seq >= estado.proximo) chunk = ponta;
        if (chunk !== null) estado.esperandoChave = false;
        else pedirChave('esperando-idr'); // o encoder limita a um IDR a cada 500 ms
      } else {
        chunk = recentes.find((c) => c.seq === estado.proximo) ?? null;
        // Ficou para trás do que ainda está na memória: só um IDR salva a cadeia.
        if (chunk === null && recentes.length > 0 && estado.proximo < recentes[0].seq) {
          estado.esperandoChave = true;
          pedirChave('atrasado');
        }
      }
      if (chunk === null) {
        estado.descartados += 1;
        continue; // sem quadro novo: este slot não vai ao ar
      }
      estado.proximo = chunk.seq + 1;
      // Cópia por sender: o ArrayBuffer de um quadro não pode ser de dois.
      quadro.data = chunk.data.slice(0);
      try {
        const md = quadro.getMetadata();
        if (typeof quadro.setMetadata === 'function') {
          quadro.setMetadata({ ...md, width: chunk.width, height: chunk.height });
        }
      } catch {
        // metadado é dica para extensões de cabeçalho; o decoder lê o SPS.
      }
      await escritor.write(quadro);
      estado.enviados += 1;
    }
  })();
};
