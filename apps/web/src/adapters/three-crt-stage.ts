import {
  AdditiveBlending,
  Box3,
  CanvasTexture,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  type Material,
  type Object3D,
} from 'three';
import { FOV_FINAL, type QuadroAbertura } from '../core/intro/timeline.js';
import {
  BASE_HEX,
  FUNDO_HEX,
  carregaModelo,
  descartaCena,
  restauraContornos,
} from './crt-modelo.js';
import type {
  AberturaPalcoOpcoes,
  PalcoAbertura,
  PlacaDaTela,
} from '../core/ports/intro-stage.js';

/**
 * O tubo, em three.js.
 *
 * # O modelo
 *
 * `public/tela-crt.glb` sai de `scripts/build-3d.mjs`: 208 KB, 31.692
 * triângulos, todo material `KHR_materials_unlit`. Cel shading aqui não é um
 * shader de rampa — é cor chapada mais contorno de casca invertida, os nós
 * `contorno_*`, que já vêm modelados. Por isso a cena não tem luz nenhuma:
 * `AmbientLight` e `DirectionalLight` não mudariam um pixel, e o `ToneMapping`
 * lavaria justamente as cores chapadas que sustentam o desenho.
 *
 * O modelo é normalizado no carregamento em vez de no modelador: a altura do
 * vidro vira 1,0 e a face frontal do vidro vai para `z = 0`, que é o sistema de
 * coordenadas da §1 da coreografia. Assim os números de câmera da §3 valem
 * como estão escritos, e trocar o `.glb` por outro não obriga a recalibrar a
 * timeline.
 *
 * # Os dois planos da tela
 *
 * O modelo traz DOIS quadriláteros abaulados no mesmo lugar:
 * `vidro_tubo` (atrás) e `tubo_chiado` (1,4 mm à frente). Aqui:
 *
 * - `vidro_tubo` recebe o shader com as sete camadas da §4 e o barril da §5;
 * - `tubo_chiado` vira só o brilho do vidro — os dois riscos diagonais que já
 *   estavam pintados na textura do material `vidro`, somados por cima. É o
 *   reflexo que faz o vidro parecer vidro, e é a única coisa que a coreografia
 *   não pede e eu mantive: sem ele o tubo lê como um retângulo preto.
 *
 * # Desvio da §6: a interface dentro do tubo
 *
 * A especificação manda usar a opção **A** — renderizar a home para uma imagem
 * e usá-la como textura — com um requisito absoluto: mesma largura de viewport
 * do DOM real, senão o crossfade denuncia.
 *
 * Não existe API de navegador que fotografe o DOM. As saídas reais são
 * `foreignObject`, que não enxerga as fontes carregadas pela página e recalcula
 * a largura de cada palavra, ou uma biblioteca de terceiro só para isso.
 *
 * O que está aqui satisfaz o requisito por construção e não é a opção C: a L3
 * é o CONTORNO das caixas da home, medido no DOM vivo com
 * `getBoundingClientRect` no momento da sondagem. Não há segunda fonte de
 * verdade para divergir — a régua é o próprio layout — e a escala bate porque
 * é a mesma janela. Também é melhor: um CRT sintonizando mostra estrutura
 * antes de detalhe, que é exatamente o que os três rasgos da §4 encenam.
 *
 * # Desvio da §4: onde a L3 é amostrada
 *
 * As camadas de conteúdo (L2 chiado, L3 interface, L4 scanlines, L5 roll bar)
 * são amostradas em ESPAÇO DE TELA, não na UV do quadrilátero. Para as
 * scanlines isso é a própria §4 ("período em espaço de tela, não em UV" — em
 * UV elas engrossam durante o dolly). Para a L3 é o que torna o handoff exato:
 * em `t = 1,80`, com `k1 = 0`, o pixel da textura está no mesmo lugar do pixel
 * do DOM em QUALQUER viewport, sem calcular projeção nenhuma.
 *
 * O efeito colateral é bonito e intencional: a interface não faz zoom junto com
 * o tubo. O tubo é que se abre em volta dela até sair de quadro. A moldura
 * desaparece e a interface já estava lá, no tamanho final.
 *
 * A ignição (L1) e a vinheta (L6) continuam na UV do quadrilátero: as duas são
 * gestos DO TUBO, não do conteúdo — a linha nasce no centro do vidro e a
 * vinheta é a curvatura dele.
 */

/**
 * O shader inteiro trabalha em sRGB e converte para linear na última linha.
 *
 * `THREE.Color` converteria estes hex para o espaço linear de trabalho na
 * construção, e um `ShaderMaterial` cru não desfaz isso — o resultado seria a
 * base do tubo clara demais e o chiado estourado. Por isso um `Vector3` com os
 * componentes literais, e a conversão explícita no fim do fragmento.
 */
const BASE_SRGB = new Vector3(0x0a / 255, 0x0f / 255, 0x12 / 255);

/** Fundo da cena: `void`, a mesma cor do `body`. O canvas é opaco (§7). */
const FUNDO = new Color(FUNDO_HEX);

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform sampler2D uInterface;
  uniform float uZoomUi;      // quanto a página encolhe para caber no vidro
  uniform vec2  uResolucao;   // pixels de dispositivo
  uniform float uDpr;
  uniform float uK1;
  uniform float uChiado;
  uniform float uUi;
  uniform float uScanlines;
  uniform float uRoll;        // < -1.0 = desligada
  uniform float uVinheta;
  uniform vec3  uIgnicao;     // largura, altura, opacidade
  uniform float uTempo;
  uniform vec3  uBase;
  uniform vec4  uRasgos[3];   // y0, y1, dx, ativo
  uniform int   uNumRasgos;

  float ruido(vec2 semente) {
    return fract(sin(dot(semente, vec2(12.9898, 78.233))) * 43758.5453);
  }

  // O renderizador converte linear -> sRGB na saída. Como este shader compõe em
  // sRGB (é onde os tokens da ADR 0008 fazem sentido), a última coisa que ele
  // faz é desfazer essa conversão.
  vec3 paraLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }

  void main() {
    vec2 tela = gl_FragCoord.xy / uResolucao;   // y para cima

    // §5 — barril. Amostrar mais longe do centro nas bordas ABAULA a imagem.
    vec2 p = tela * 2.0 - 1.0;
    vec2 amostra = p * (1.0 + uK1 * dot(p, p));

    // A página inteira cabe dentro do vidro, e vai crescendo até 1:1 com o DOM
    // no handoff. Ver a nota sobre uZoomUi no topo do arquivo.
    amostra *= uZoomUi;

    // §4 — os rasgos de sintonia deslocam faixas horizontais da imagem.
    for (int i = 0; i < 3; i++) {
      if (i >= uNumRasgos) break;
      vec4 r = uRasgos[i];
      float dentro = step(r.x, amostra.y * 0.5 + 0.5) * step(amostra.y * 0.5 + 0.5, r.y);
      amostra.x += r.z * 2.0 * dentro;
    }

    vec2 uv = amostra * 0.5 + 0.5;

    // L0
    vec3 cor = uBase;

    // L1 — a linha de ignição. UV do vidro: é gesto do tubo, não do conteúdo.
    //
    // O piso da espessura vem de fwidth, que é quanto de UV cabe num pixel
    // NESTE fragmento. Com um piso fixo em UV a barra de 2px virava 0,8px na
    // tela e saía tracejada pelo serrilhado; com fwidth ela nunca fica mais
    // fina que um pixel, esteja o tubo perto ou longe.
    float pixelUv = fwidth(vUv.y);
    float meiaAltura = max(uIgnicao.y * 0.5, pixelUv);
    float naLinha =
      (1.0 - smoothstep(meiaAltura - pixelUv, meiaAltura + pixelUv, abs(vUv.y - 0.5))) *
      step(abs(vUv.x - 0.5), uIgnicao.x * 0.5);
    cor = mix(cor, vec3(1.0), naLinha * uIgnicao.z);

    // L2 — chiado. Blocos de 2 px e 24 amostras por segundo: granulado de
    // tubo, não cintilância de pixel, e não pior em tela de alta densidade.
    float n = ruido(floor(gl_FragCoord.xy * 0.5) + floor(uTempo * 24.0) * vec2(37.0, 17.0));
    cor = mix(cor, vec3(n * 0.82 + 0.06), uChiado);

    // L3 — a interface. Fora do quadro da janela não há nada para mostrar.
    float dentroDaJanela =
      step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    vec3 interfaceCor = texture2D(uInterface, uv).rgb;
    cor = mix(cor, interfaceCor, uUi * dentroDaJanela);

    // L4 — scanlines com período de 3 px CSS. Em UV elas engrossariam no dolly.
    float linha = mod(gl_FragCoord.y / uDpr, 3.0);
    cor *= 1.0 - uScanlines * step(linha, 1.0);

    // L5 — roll bar. Faixa de 18% da altura, branco a 6%.
    if (uRoll > -1.0) {
      float faixa = smoothstep(0.09, 0.0, abs(tela.y - (1.0 - uRoll)));
      cor += vec3(0.06) * faixa;
    }

    // L6 — vinheta. UV do vidro: é a curvatura do tubo.
    vec2 q = vUv * 2.0 - 1.0;
    cor *= 1.0 - uVinheta * smoothstep(0.5, 1.5, dot(q, q));

    gl_FragColor = vec4(paraLinear(cor), 1.0);
  }
`;

/**
 * Desenha as caixas medidas no DOM numa textura do tamanho da janela.
 *
 * As cores saem da tabela de tokens da ADR 0008 — o tubo e a página falam a
 * mesma paleta, senão o crossfade acusa a troca em cor antes de acusar em
 * forma.
 */
function pintaInterface(
  placas: readonly PlacaDaTela[],
  larguraCss: number,
  alturaCss: number,
): HTMLCanvasElement {
  // Teto de 1280 px: a textura é vista por 0,9 s atrás de scanlines e vinheta,
  // e uma tela 4K faria 8 MB de VRAM para nada.
  const escala = Math.min(1, 1280 / Math.max(1, larguraCss));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(larguraCss * escala));
  canvas.height = Math.max(1, Math.round(alturaCss * escala));

  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;

  ctx.scale(escala, escala);
  ctx.fillStyle = BASE_HEX;
  ctx.fillRect(0, 0, larguraCss, alturaCss);

  for (const placa of placas) {
    const { x, y, largura, altura, tipo } = placa;
    if (tipo === 'contorno') {
      ctx.strokeStyle = '#5E5E69';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, largura - 1, altura - 1);
    } else if (tipo === 'preenchido') {
      ctx.fillStyle = '#121216';
      ctx.fillRect(x, y, largura, altura);
    } else if (tipo === 'acento') {
      ctx.fillStyle = '#22E07A';
      ctx.fillRect(x, y, largura, altura);
    } else {
      ctx.fillStyle = '#8A8A96';
      ctx.fillRect(x, y, largura, altura);
    }
  }

  return canvas;
}

/**
 * Quanto da janela inicial o aparelho pode ocupar. O resto é respiro.
 *
 * # Desvio da §1, e por quê
 *
 * A §1 estabelece o espaço pela altura do TUBO: "altura do tubo 1.0 unidade".
 * Seguindo isso ao pé da letra neste modelo, o aparelho fica com 3,04 unidades
 * de altura — o gabinete e as antenas valem três vezes o tubo — e a janela da
 * câmera em `t = 0` (z 2,95, FOV 32°) mede 1,69. O aparelho estourava o quadro
 * por todos os lados: aparecia um retângulo escuro com um vidro no meio, e o
 * objeto 3D que a abertura existe para mostrar ficava irreconhecível.
 *
 * A §1 descreve as proporções do modelo que ela imaginava, não uma regra sobre
 * o modelo que existe. O que ela quer — e o que a §3 quer — é o aparelho no
 * quadro. Então a régua muda de peça: o aparelho é escalado para caber na
 * janela inicial, nos DOIS eixos.
 *
 * Nos dois eixos, e não só na altura, porque num celular em pé a janela é
 * estreita: encaixando só pela altura, o aparelho sai pelas laterais e a
 * abertura vira um gabinete cortado.
 */
const OCUPACAO_INICIAL = 0.86;

/** Distância e FOV do primeiro keyframe da §3. É a janela que precisa caber. */
const Z_INICIAL = 2.95;
const FOV_INICIAL = 32;

/**
 * Encaixa o aparelho na janela inicial e põe o vidro na origem.
 *
 * Medir em vez de fixar números é o que permite trocar o `.glb` por outro sem
 * recalibrar a timeline inteira — e é o que faz a mesma cena funcionar num
 * monitor 16:10 e num celular em pé, que é uma diferença de 3,5× em proporção.
 */
function normaliza(raiz: Object3D, vidro: Object3D, aspecto: number): void {
  const bruto = new Box3().setFromObject(raiz).getSize(new Vector3());
  const alturaVisivel = 2 * Z_INICIAL * Math.tan((FOV_INICIAL * Math.PI) / 360);
  const larguraVisivel = alturaVisivel * aspecto;

  const porAltura = bruto.y > 0 ? (alturaVisivel * OCUPACAO_INICIAL) / bruto.y : 1;
  const porLargura = bruto.x > 0 ? (larguraVisivel * OCUPACAO_INICIAL) / bruto.x : 1;
  raiz.scale.setScalar(Math.min(porAltura, porLargura));
  raiz.updateMatrixWorld(true);

  // O alvo da câmera é (0,0,0) o tempo todo, então quem tem de estar na origem
  // é o VIDRO — não o aparelho. Num CRT os dois quase coincidem, mas "quase"
  // vira um desalinhamento visível quando a câmera chega a 0,2 de distância.
  const tela = new Box3().setFromObject(vidro);
  const centro = tela.getCenter(new Vector3());
  raiz.position.set(-centro.x, -centro.y, -tela.min.z);
  raiz.updateMatrixWorld(true);
}

/**
 * Onde o dolly precisa parar para o vidro cobrir a janela inteira.
 *
 * Sobra deliberada: 1,9× na altura e 1,15× na largura. O vidro é abaulado, a
 * borda dele curva para trás, e chegar "na conta exata" deixa a moldura
 * espiando num canto — que é justamente o que o crossfade não pode denunciar.
 */
const SOBRA_VERTICAL = 1.9;
const SOBRA_HORIZONTAL = 1.15;

function zDoHandoff(vidro: Box3, aspecto: number, fovFinal: number): number {
  const tamanho = vidro.getSize(new Vector3());
  const alturaVisivel = Math.min(
    tamanho.y / SOBRA_VERTICAL,
    tamanho.x / (SOBRA_HORIZONTAL * aspecto),
  );
  return vidro.max.z + alturaVisivel / (2 * Math.tan((fovFinal * Math.PI) / 360));
}

export const abrirPalco = async ({
  canvas,
  modeloUrl,
  placas,
  larguraCss,
  alturaCss,
  dpr,
  sinal,
}: AberturaPalcoOpcoes): Promise<PalcoAbertura> => {
  /*
    A ordem aqui é medida, não estética.

    `GLTFLoader.load()` dispara o fetch de forma síncrona; o construtor do
    `WebGLRenderer` bloqueia a thread por ~190 ms no primeiro contexto da aba,
    pagando o aperto de mão com o processo de GPU. Disparando o download ANTES,
    a rede trabalha durante esse bloqueio em vez de esperar por ele — o prazo de
    700 ms do modelo passa a caber os dois custos em vez de somá-los.
  */
  const carregando = carregaModelo(modeloUrl, sinal);

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(dpr);
  renderer.setSize(larguraCss, alturaCss, false);

  const raiz = await carregando;

  const vidro = raiz.getObjectByName('vidro_tubo');
  const brilho = raiz.getObjectByName('tubo_chiado');
  if (!(vidro instanceof Mesh)) {
    renderer.dispose();
    throw new Error('o modelo não tem o nó `vidro_tubo` — rode scripts/build-3d.mjs');
  }

  const aspecto = larguraCss / alturaCss;
  restauraContornos(raiz);
  normaliza(raiz, vidro, aspecto);

  // `CanvasTexture` e não `Texture`: `flipY` no envio é o que põe a linha 0 do
  // canvas (o topo da janela) em `v = 1`, que é onde o shader a procura.
  const interfaceTex = new CanvasTexture(pintaInterface(placas, larguraCss, alturaCss));

  const uniforms = {
    uInterface: { value: interfaceTex },
    uZoomUi: { value: 1 },
    uResolucao: { value: new Vector2(larguraCss * dpr, alturaCss * dpr) },
    uDpr: { value: dpr },
    uK1: { value: 0.28 },
    uChiado: { value: 0 },
    uUi: { value: 0 },
    uScanlines: { value: 0 },
    uRoll: { value: -9 },
    uVinheta: { value: 0 },
    uIgnicao: { value: new Vector3(0, 0, 0) },
    uTempo: { value: 0 },
    uBase: { value: BASE_SRGB },
    uRasgos: { value: [new Vector4(), new Vector4(), new Vector4()] },
    uNumRasgos: { value: 0 },
  };

  const materialAnterior = vidro.material as Material;
  vidro.material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });

  /**
   * O plano da frente vira o reflexo do vidro.
   *
   * A textura vem do material `vidro` original — os dois riscos diagonais do
   * cel shading. Somada (`additive`) e a 8%, ela lê como brilho; opaca, leria
   * como sujeira em cima da interface.
   */
  if (brilho instanceof Mesh) {
    const anterior = brilho.material as Material;
    const mapa = materialAnterior instanceof MeshBasicMaterial ? materialAnterior.map : null;
    brilho.material = new MeshBasicMaterial({
      map: mapa,
      transparent: true,
      opacity: 0.05,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    anterior.dispose();
  }
  materialAnterior.dispose();

  /*
    Geometria do vidro depois de normalizado. É daqui que sai `uZoomUi`, quadro
    a quadro: enquanto o vidro é menor que a janela, a página é reduzida para
    caber DENTRO dele — um aparelho de TV mostra a imagem inteira, não um
    pedaço dela. Quando o dolly faz o vidro cobrir a janela, o fator satura em
    1,0 e a textura volta a bater pixel a pixel com o DOM, que é o que torna o
    crossfade do handoff invisível.
  */
  const caixaDoVidro = new Box3().setFromObject(vidro);
  const alturaDoVidro = caixaDoVidro.getSize(new Vector3()).y;
  const frenteDoVidro = caixaDoVidro.max.z;
  let zFinal = zDoHandoff(caixaDoVidro, aspecto, FOV_FINAL);

  const cena = new Scene();
  cena.background = FUNDO;
  cena.add(raiz);

  const camera = new PerspectiveCamera(32, larguraCss / alturaCss, 0.01, 40);
  const alvo = new Vector3(0, 0, 0);

  const pinta = (quadro: QuadroAbertura) => {
      camera.position.set(quadro.camera.x, quadro.camera.y, quadro.camera.z);
      camera.lookAt(alvo);
      if (camera.fov !== quadro.camera.fov) {
        camera.fov = quadro.camera.fov;
        camera.updateProjectionMatrix();
      }

      const distancia = Math.max(quadro.camera.z - frenteDoVidro, 1e-3);
      const alturaVisivel = 2 * distancia * Math.tan((quadro.camera.fov * Math.PI) / 360);
      uniforms.uZoomUi.value = Math.max(1, alturaVisivel / alturaDoVidro);

      uniforms.uK1.value = quadro.k1;
      uniforms.uChiado.value = quadro.chiado;
      uniforms.uUi.value = quadro.ui;
      uniforms.uScanlines.value = quadro.scanlines;
      uniforms.uVinheta.value = quadro.vinheta;
      uniforms.uRoll.value = quadro.roll ?? -9;
      uniforms.uTempo.value = quadro.t;
      uniforms.uIgnicao.value.set(
        quadro.ignicao.largura,
        quadro.ignicao.altura,
        quadro.ignicao.opacidade,
      );

      uniforms.uNumRasgos.value = quadro.rasgos.length;
      quadro.rasgos.forEach((rasgo, i) => {
        const alvoRasgo = uniforms.uRasgos.value[i];
        if (alvoRasgo === undefined) return;
        // A faixa da §4 é medida de CIMA para baixo; o shader trabalha com y
        // para cima. A inversão mora aqui, não no shader, para o GLSL não ter
        // uma convenção só dele.
        alvoRasgo.set(1 - rasgo.y1, 1 - rasgo.y0, rasgo.dx, 1);
      });

    renderer.render(cena, camera);
  };

  return {
    render: pinta,

    zFinal: () => zFinal,

    aquece(quadro) {
      const inicio = performance.now();
      pinta(quadro);
      // `finish()` bloqueia até a GPU esvaziar a fila. É o único jeito de a
      // medida significar alguma coisa — ver a nota da port.
      renderer.getContext().finish();
      return performance.now() - inicio;
    },

    redimensiona(largura, altura, novoDpr) {
      camera.aspect = largura / altura;
      camera.updateProjectionMatrix();
      // A janela mudou de proporção, então o ponto de parada do dolly mudou
      // junto: girar o celular no meio da abertura não pode fazer a moldura
      // aparecer no handoff.
      zFinal = zDoHandoff(caixaDoVidro, camera.aspect, FOV_FINAL);
      renderer.setPixelRatio(novoDpr);
      renderer.setSize(largura, altura, false);
      uniforms.uResolucao.value.set(largura * novoDpr, altura * novoDpr);
      uniforms.uDpr.value = novoDpr;
    },

    dispose() {
      descartaCena(cena);
      interfaceTex.dispose();
      renderer.dispose();
      // Sem isto o contexto WebGL sobrevive ao canvas removido do DOM, e a
      // GPU segue alocada — o §7 é explícito sobre o aparelho esquentando.
      renderer.forceContextLoss();
    },
  };
};
