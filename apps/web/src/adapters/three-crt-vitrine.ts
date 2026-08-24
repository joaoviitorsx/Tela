import {
  Box3,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { poseParada, poseVitrine, type Ponteiro } from '../core/vitrine/pose.js';
import type {
  EstadoVitrine,
  StatusCanal,
  Vitrine,
  VitrineOpcoes,
} from '../core/ports/crt-vitrine.js';
import { BASE_HEX, carregaModelo, descartaCena, restauraContornos } from './crt-modelo.js';

/**
 * O aparelho ao lado do campo, ligado.
 *
 * # O que ele é
 *
 * A mesma peça da abertura, na mesma paleta, mas com outro trabalho: enquanto a
 * abertura é uma cena de 1,8 s que some, isto é um monitor. O que a pessoa
 * digita no campo aparece no tubo. Campo vazio, o tubo mostra chiado e SEM
 * SINAL — que é literalmente o estado do canal antes de ele ter nome.
 *
 * As três lâmpadas da lateral já vinham modeladas e são exatamente o vocabulário
 * de estado da ADR 0008: âmbar enquanto confere, vermelho quando o nome não
 * serve, verde quando está pronto para ir ao ar. Verde ali é o mesmo verde do AO
 * VIVO um passo antes dele, não um segundo uso do acento.
 *
 * # Três coisas que custam bateria, e o que foi feito com elas
 *
 * Esta cena não termina — ela vive enquanto a tela inicial estiver aberta, o que
 * pode ser horas com o jogo rodando na mesma GPU. A §11 da coreografia já tinha
 * decidido o padrão para esse caso (12 fps e pausa total com a aba oculta), e é
 * o mesmo padrão aqui, com folga:
 *
 * - **30 fps por quadro contado**, não 60. O pêndulo leva 13 s para ir e voltar;
 *   dobrar a taxa não muda nada que o olho perceba e dobra o custo.
 * - **Pausa com a aba oculta** e **pausa fora da viewport**. Rolar a página para
 *   o console de qualidade já para o desenho.
 * - **`prefers-reduced-motion` desliga o laço inteiro**: desenha uma vez e só
 *   volta a desenhar quando o estado do canal muda.
 *
 * # Scanline em UV, ao contrário da abertura
 *
 * A §4 manda período em espaço de tela, e na abertura isso é obrigatório: a
 * câmera entra no tubo e em UV as linhas engrossariam até virar listras. Aqui a
 * câmera não se move e o tubo GIRA — em espaço de tela as linhas ficariam
 * paradas enquanto o vidro roda por baixo, como se estivessem no monitor de
 * quem olha, e não no tubo. Em UV elas giram junto com o vidro, que é onde elas
 * moram num CRT de verdade.
 */

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;

  varying vec2 vUv;

  uniform sampler2D uConteudo;
  uniform float uK1;
  uniform float uChiado;
  uniform float uLinhas;
  uniform float uRoll;
  uniform float uTempo;
  uniform vec3  uBase;

  float ruido(vec2 semente) {
    return fract(sin(dot(semente, vec2(12.9898, 78.233))) * 43758.5453);
  }

  // O renderizador converte linear -> sRGB na saída, e este shader compõe em
  // sRGB, que é onde os tokens da ADR 0008 fazem sentido. A última linha desfaz.
  vec3 paraLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }

  void main() {
    // Barril: amostrar mais longe do centro nas bordas ABAULA a imagem.
    vec2 p = vUv * 2.0 - 1.0;
    vec2 uv = (p * (1.0 + uK1 * dot(p, p))) * 0.5 + 0.5;

    vec3 cor = uBase;

    float dentro = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    cor = mix(cor, texture2D(uConteudo, uv).rgb, dentro);

    // Chiado em blocos e amostrado a 24 Hz: granulado de tubo, não cintilância
    // de pixel — e não fica pior em tela de alta densidade.
    float n = ruido(floor(vUv * 220.0) + floor(uTempo * 24.0) * vec2(37.0, 17.0));
    cor = mix(cor, vec3(n * 0.82 + 0.06), uChiado);

    // Scanlines na UV do vidro. Ver a nota no topo sobre por que aqui é ao
    // contrário da abertura.
    cor *= 1.0 - 0.3 * step(fract(vUv.y * uLinhas), 0.42);

    // Roll bar: a faixa clara larga descendo devagar, 18% da altura.
    cor += vec3(0.05) * smoothstep(0.09, 0.0, abs(vUv.y - uRoll));

    // Vinheta: a curvatura do tubo.
    cor *= 1.0 - 0.45 * smoothstep(0.45, 1.5, dot(p, p));

    gl_FragColor = vec4(paraLinear(cor), 1.0);
  }
`;

const LARGURA_TEXTURA = 512;
const ALTURA_TEXTURA = 348;

/** Onde cada estado do canal acende. `null` = nenhuma lâmpada. */
const LAMPADA: Record<StatusCanal, string | null> = {
  vazio: null,
  verificando: 'led_ambar',
  invalido: 'led_vermelho',
  livre: 'led_verde',
};

/** O que o tubo escreve embaixo do endereço. A cor sozinha nunca basta (ADR 0008 §3). */
const OSD: Record<StatusCanal, string> = {
  vazio: 'SEM SINAL',
  verificando: 'SINTONIZANDO',
  invalido: 'NOME INVÁLIDO',
  livre: 'PRONTO PARA IR AO AR',
};

/** As cores das lâmpadas vêm da tabela da ADR 0008, não do modelo. */
const CORES_ACESAS: Record<string, string> = {
  led_verde: '#22e07a',
  led_ambar: '#ffb020',
  led_vermelho: '#ff4d4d',
};

/** Apagada é a mesma cor a 22%: dá para ver que a lâmpada existe. */
const CORES_APAGADAS: Record<string, string> = {
  led_verde: '#0a3520',
  led_ambar: '#3a2a0c',
  led_vermelho: '#3a1616',
};

/** Chiado de fundo por estado: sem nome, o tubo não tem o que mostrar. */
const CHIADO_DE_FUNDO: Record<StatusCanal, number> = {
  // 0,34 e não 0,5: mais que isso, o chiado come o próprio "SEM SINAL" e o tubo
  // vira um quadrado cinza sem recado nenhum.
  vazio: 0.34,
  verificando: 0.12,
  invalido: 0.1,
  livre: 0.05,
};

/**
 * Acha o maior corpo em que o texto ainda cabe na largura pedida.
 *
 * O slug vai de 3 a 25 caracteres, e um corpo fixo teria de caber no pior caso
 * — 25 letras —, o que deixaria "jv" minúsculo no meio de uma tela vazia. O
 * tubo enche do nome que tiver.
 */
function corpoQueCabe(
  ctx: CanvasRenderingContext2D,
  texto: string,
  peso: number,
  maximo: number,
  largura: number,
): number {
  let corpo = maximo;
  for (; corpo > 16; corpo -= 2) {
    ctx.font = `${peso} ${corpo}px "Barlow Condensed", system-ui, sans-serif`;
    if (ctx.measureText(texto).width <= largura) break;
  }
  return corpo;
}

/**
 * A tela do tubo, desenhada em 2D.
 *
 * Só é repintada quando o estado muda — nunca por quadro. Chiado, scanline,
 * roll bar e barril são do shader, que é onde eles custam quase nada.
 *
 * # O que NÃO está aqui
 *
 * O prefixo `tela.gg/`. Ele estava, e saiu: o vidro tem uns 130 px na tela e o
 * endereço inteiro em monoespaçada dava 5 px por letra — presença sem leitura.
 * O campo a 40 cm dali já mostra a URL completa em corpo de herói; o tubo
 * mostra a parte que é escolha da pessoa.
 *
 * Em condensada e não em monoespaçada pelo mesmo motivo. Tabular importa onde o
 * número muda sozinho e a largura não pode dançar; aqui o texto é um nome, e o
 * que importa é caber e ser lido de longe.
 *
 * Minúsculas, e não caixa alta de identidade de emissora, que seria mais
 * bonito: o slug É minúsculo por regra, e mostrá-lo em caixa alta ao lado de um
 * campo que mostra minúsculas convida a pessoa a digitar caixa alta.
 */
function pintaTela(ctx: CanvasRenderingContext2D, { slug, status }: EstadoVitrine): void {
  const L = LARGURA_TEXTURA;
  const A = ALTURA_TEXTURA;
  ctx.clearRect(0, 0, L, A);
  ctx.fillStyle = BASE_HEX;
  ctx.fillRect(0, 0, L, A);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const vazio = slug === '';
  const herói = vazio ? 'SEM SINAL' : slug;

  ctx.fillStyle = vazio ? '#8a8a96' : status === 'invalido' ? '#ff4d4d' : '#ededf0';
  corpoQueCabe(ctx, herói, 600, vazio ? 86 : 96, L * 0.86);
  ctx.fillText(herói, L / 2, A / 2 + 14);

  ctx.fillStyle = status === 'invalido' ? '#ff4d4d' : status === 'livre' ? '#22e07a' : '#8a8a96';
  ctx.font = '600 26px "Barlow Condensed", system-ui, sans-serif';
  ctx.letterSpacing = '0.16em';
  ctx.fillText(vazio ? 'ESCOLHA UM NOME AO LADO' : OSD[status], L / 2, A / 2 + 66);
  ctx.letterSpacing = '0px';
}

/**
 * Enquadra o aparelho no canvas, medindo em vez de fixar números.
 *
 * A largura projetada cresce quando ele gira — na amplitude cheia o gabinete
 * ocupa mais que a própria largura de frente, porque a profundidade entra em
 * cena. Encaixar pela pose parada deixaria a antena batendo na borda no meio do
 * pêndulo.
 */
const FOV = 28;
const FOLGA = 0.86;
const GIRO_MAXIMO = 0.45 + 0.2;

function enquadra(raiz: Object3D, vidro: Object3D, aspecto: number): number {
  const bruto = new Box3().setFromObject(raiz).getSize(new Vector3());
  raiz.scale.setScalar(bruto.y > 0 ? 1 / bruto.y : 1);
  raiz.updateMatrixWorld(true);

  const tamanho = new Box3().setFromObject(raiz).getSize(new Vector3());
  const larguraGirando =
    tamanho.x * Math.cos(GIRO_MAXIMO) + tamanho.z * Math.sin(GIRO_MAXIMO);

  const centro = new Box3().setFromObject(vidro).getCenter(new Vector3());
  raiz.position.set(-centro.x, -centro.y, 0);
  raiz.updateMatrixWorld(true);

  const precisaDeAltura = tamanho.y / FOLGA;
  const precisaDeLargura = larguraGirando / FOLGA / aspecto;
  const visivel = Math.max(precisaDeAltura, precisaDeLargura);
  return visivel / (2 * Math.tan((FOV * Math.PI) / 360));
}

export const abrirVitrine = async ({
  canvas,
  modeloUrl,
  largura,
  altura,
  dpr,
  movimentoReduzido,
  estadoInicial,
  aoClicar,
  sinal,
}: VitrineOpcoes): Promise<Vitrine> => {
  const carregando = carregaModelo(modeloUrl, sinal);

  // `alpha: true` e sem `background`: o aparelho fica em pé sobre a página em
  // vez de dentro de um retângulo. Uma vitrine não tem moldura.
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(largura, altura, false);
  renderer.setClearAlpha(0);

  const raiz = await carregando;
  const vidro = raiz.getObjectByName('vidro_tubo');
  if (!(vidro instanceof Mesh)) {
    renderer.dispose();
    throw new Error('o modelo não tem o nó `vidro_tubo` — rode scripts/build-3d.mjs');
  }

  restauraContornos(raiz);
  const distancia = enquadra(raiz, vidro, largura / altura);

  const tela = document.createElement('canvas');
  tela.width = LARGURA_TEXTURA;
  tela.height = ALTURA_TEXTURA;
  const ctx = tela.getContext('2d');
  const textura = new CanvasTexture(tela);

  const uniforms = {
    uConteudo: { value: textura },
    uK1: { value: 0.16 },
    uChiado: { value: CHIADO_DE_FUNDO[estadoInicial.status] },
    uLinhas: { value: 60 },
    uRoll: { value: -1 },
    uTempo: { value: 0 },
    uBase: { value: new Vector3(0x0a / 255, 0x0f / 255, 0x12 / 255) },
  };

  const materialDoVidro = vidro.material as MeshBasicMaterial;
  vidro.material = new ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT });
  materialDoVidro.dispose();

  // O plano da frente vira o reflexo do vidro, com a textura de brilho que já
  // vinha no material original. Sem ele o tubo lê como um retângulo preto.
  const brilho = raiz.getObjectByName('tubo_chiado');
  if (brilho instanceof Mesh) {
    const anterior = brilho.material as MeshBasicMaterial;
    brilho.material = new MeshBasicMaterial({
      map: materialDoVidro.map,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
    });
    anterior.dispose();
  }

  /**
   * Cada lâmpada ganha material próprio.
   *
   * O `dedup()` do pipeline funde materiais iguais, e o vermelho da lâmpada é o
   * mesmo das pontas das antenas. Sem clonar, apagar a lâmpada apagaria as
   * antenas junto.
   */
  const lampadas = new Map<string, MeshBasicMaterial>();
  for (const nome of ['led_verde', 'led_ambar', 'led_vermelho']) {
    const no = raiz.getObjectByName(nome);
    if (!(no instanceof Mesh)) continue;
    const material = (no.material as MeshBasicMaterial).clone();
    no.material = material;
    lampadas.set(nome, material);
  }

  const acende = (status: StatusCanal) => {
    const ligada = LAMPADA[status];
    for (const [nome, material] of lampadas) {
      const cor = nome === ligada ? CORES_ACESAS[nome] : CORES_APAGADAS[nome];
      if (cor !== undefined) material.color.setStyle(cor);
    }
  };

  // `YXZ`: o giro do pêndulo é a rotação de FORA, e a inclinação do ponteiro
  // acontece dentro dela. Na ordem padrão (`XYZ`) a inclinação vira a de fora e
  // o aparelho balança em torno de um eixo que gira junto — parece solto.
  raiz.rotation.order = 'YXZ';

  const cena = new Scene();
  cena.add(raiz);

  const camera = new PerspectiveCamera(FOV, largura / altura, 0.05, 40);
  camera.position.set(0, 0, distancia);
  camera.lookAt(0, 0, 0);

  let estado = estadoInicial;
  if (ctx !== null) pintaTela(ctx, estado);
  textura.needsUpdate = true;
  acende(estado.status);

  /* ───────────────── ponteiro, clique e raio ───────────────── */

  const raio = new Raycaster();
  const ponteiroNdc = new Vector2();
  let ponteiro: Ponteiro | null = null;
  let sobreOTubo = false;
  let impulso = 0;

  const aoMover = (evento: PointerEvent) => {
    const caixa = canvas.getBoundingClientRect();
    const x = ((evento.clientX - caixa.left) / caixa.width) * 2 - 1;
    const y = ((evento.clientY - caixa.top) / caixa.height) * 2 - 1;
    ponteiro = { x, y };
    ponteiroNdc.set(x, -y);
  };
  const aoSair = () => {
    ponteiro = null;
    sobreOTubo = false;
    canvas.style.cursor = '';
  };
  const aoApertar = (evento: PointerEvent) => {
    if (!sobreOTubo) return;
    // Sem isto o clique acaba roubando o foco que `aoClicar` acabou de dar ao
    // campo: o `pointerdown` roda primeiro, o campo ganha o cursor, e em
    // seguida o comportamento padrão do `mousedown` tira o foco de lá.
    // Só para mouse e caneta — em toque, `preventDefault` no `pointerdown`
    // cancelaria a rolagem da página.
    if (evento.pointerType !== 'touch') evento.preventDefault();
    impulso = 1;
    aoClicar();
    if (movimentoReduzido) desenha(0);
  };

  canvas.addEventListener('pointermove', aoMover);
  canvas.addEventListener('pointerleave', aoSair);
  canvas.addEventListener('pointerdown', aoApertar);

  /* ───────────────── o laço ───────────────── */

  const inicio = performance.now();
  let ultimoQuadro = 0;
  /** 30 fps. Ver a nota sobre bateria no topo. */
  const INTERVALO_MS = 1000 / 30;
  /** O clique se apaga em ~0,6 s. Em segundos, não em quadros: a 30 fps e a 60
   *  o recuo tem de durar o mesmo tempo. */
  const DECAIMENTO_POR_S = 6;

  function desenha(agoraMs: number): void {
    const t = (agoraMs === 0 ? 0 : agoraMs - inicio) / 1000;
    const pose = movimentoReduzido ? poseParada() : poseVitrine({ t, ponteiro, impulso });

    raiz.rotation.set(pose.rotX, pose.rotY, 0);
    raiz.position.y = pose.alturaY - (raiz.userData['centroY'] as number);
    raiz.scale.setScalar((raiz.userData['escalaBase'] as number) * pose.escala);

    uniforms.uTempo.value = t;
    uniforms.uChiado.value = Math.max(CHIADO_DE_FUNDO[estado.status], pose.chiado);
    // A faixa desce de -0,1 a 1,1 em 4,6 s, em laço. Parada, ela não existe.
    uniforms.uRoll.value = movimentoReduzido ? -1 : -0.1 + 1.2 * ((t / 4.6) % 1);

    if (ponteiro !== null) {
      raio.setFromCamera(ponteiroNdc, camera);
      const acertou = raio.intersectObject(raiz, true).length > 0;
      if (acertou !== sobreOTubo) {
        sobreOTubo = acertou;
        canvas.style.cursor = acertou ? 'pointer' : '';
      }
    }

    renderer.render(cena, camera);
  }

  // A escala e o centro que o enquadramento calculou viram base do laço: o
  // recuo do clique multiplica a escala, não a substitui.
  raiz.userData['escalaBase'] = raiz.scale.x;
  raiz.userData['centroY'] = -raiz.position.y;

  const laco = (agora: number) => {
    const desdeOUltimo = agora - ultimoQuadro;
    if (desdeOUltimo < INTERVALO_MS) return;
    const dt = Math.min(desdeOUltimo / 1000, 0.25);
    ultimoQuadro = agora;
    impulso = impulso > 0.002 ? impulso * Math.exp(-dt * DECAIMENTO_POR_S) : 0;
    desenha(agora);
  };

  let rodando = false;
  const toca = () => {
    if (rodando || movimentoReduzido) return;
    rodando = true;
    renderer.setAnimationLoop(laco);
  };
  const para = () => {
    if (!rodando) return;
    rodando = false;
    renderer.setAnimationLoop(null);
  };

  desenha(0);

  // Aba oculta e canvas fora da viewport param o desenho. Sem os dois, uma aba
  // esquecida aberta segura a GPU do mesmo PC que vai rodar o jogo.
  let visivelNaTela = true;
  const reavalia = () => (visivelNaTela && !document.hidden ? toca() : para());
  document.addEventListener('visibilitychange', reavalia);

  const observador = new IntersectionObserver(
    ([entrada]) => {
      visivelNaTela = entrada?.isIntersecting ?? true;
      reavalia();
    },
    { threshold: 0 },
  );
  observador.observe(canvas);

  // As fontes do canvas 2D podem não estar prontas no primeiro desenho: sem
  // Barlow Condensed, "SEM SINAL" sai numa métrica que não é a do produto.
  void document.fonts?.ready.then(() => {
    if (ctx === null) return;
    pintaTela(ctx, estado);
    textura.needsUpdate = true;
    desenha(0);
  });

  return {
    mostra(novo) {
      const mudou = novo.slug !== estado.slug || novo.status !== estado.status;
      estado = novo;
      if (!mudou) return;
      if (ctx !== null) pintaTela(ctx, estado);
      textura.needsUpdate = true;
      acende(estado.status);
      if (movimentoReduzido) desenha(0);
    },

    redimensiona(novaLargura, novaAltura, novoDpr) {
      camera.aspect = novaLargura / novaAltura;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(novoDpr);
      renderer.setSize(novaLargura, novaAltura, false);
      uniforms.uLinhas.value = Math.max(24, Math.round((novaAltura * 0.55) / 3));
      if (movimentoReduzido) desenha(0);
    },

    dispose() {
      para();
      observador.disconnect();
      document.removeEventListener('visibilitychange', reavalia);
      canvas.removeEventListener('pointermove', aoMover);
      canvas.removeEventListener('pointerleave', aoSair);
      canvas.removeEventListener('pointerdown', aoApertar);
      descartaCena(cena);
      textura.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
};
