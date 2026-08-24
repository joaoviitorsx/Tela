import { BackSide, Mesh, MeshBasicMaterial, type Material, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * O que a abertura e a vitrine compartilham do modelo do tubo.
 *
 * Duas cenas usam o mesmo `.glb` por motivos diferentes — uma voa para dentro
 * dele em 1,8 s, a outra o deixa girando ao lado do campo. O que NÃO pode
 * divergir entre elas é como o modelo é carregado, como o cel shading é
 * remontado e como a GPU é devolvida. As três coisas têm armadilha, e as três
 * moram aqui.
 */

/** L0 — o fundo do tubo apagado (§4 da coreografia). Vale para as duas cenas. */
export const BASE_HEX = '#0A0F12';

/** `void`. É a cor do `body`, e é o fundo de toda cena de tubo. */
export const FUNDO_HEX = '#08080a';

export function carregaModelo(url: string, sinal: AbortSignal): Promise<Object3D> {
  return new Promise((resolve, reject) => {
    if (sinal.aborted) {
      reject(new Error('cena cancelada antes do modelo chegar'));
      return;
    }
    new GLTFLoader().load(
      url,
      (gltf) => {
        if (sinal.aborted) reject(new Error('cena cancelada'));
        else resolve(gltf.scene);
      },
      undefined,
      (erro) => reject(erro instanceof Error ? erro : new Error(String(erro))),
    );
  });
}

/**
 * Devolve os contornos de casca invertida ao lado de dentro.
 *
 * Cel shading aqui é cor chapada mais contorno, e o contorno é feito do jeito
 * clássico: uma cópia inflada da malha renderizada só pelas FACES DE TRÁS, de
 * modo que ela só apareça na silhueta.
 *
 * O glTF não sabe expressar isso. O formato só tem `doubleSided` — verdadeiro
 * ou falso — e "só o verso" não é uma das opções. O exportador do Three, que é
 * de onde este modelo saiu, escreveu `side: BackSide` em `extras` e mais nada.
 *
 * O sintoma de não corrigir isto é bem específico e foi exatamente o que
 * aconteceu na primeira montagem: as cascas infladas passam a renderizar as
 * faces da FRENTE, que estão por fora do modelo, e o aparelho inteiro fica
 * preto. Não é "escuro demais" nem problema de espaço de cor — é o contorno
 * cobrindo a peça que ele deveria contornar.
 */
export function restauraContornos(raiz: Object3D): void {
  const grupo = raiz.getObjectByName('Contorno_InvertedHull');
  if (grupo === undefined) return;
  grupo.traverse((no) => {
    if (!(no instanceof Mesh)) return;
    for (const material of Array.isArray(no.material) ? no.material : [no.material]) {
      material.side = BackSide;
    }
  });
}

/**
 * Devolve geometria, material e textura de tudo que estiver na cena.
 *
 * O three.js não libera nada sozinho: cada um deles fica na VRAM até alguém
 * chamar `dispose()`. Vale para as duas cenas, e a da vitrine vive enquanto a
 * tela inicial estiver aberta — esquecer aqui é vazamento que só aparece
 * depois de a pessoa navegar algumas vezes.
 */
export function descartaCena(raiz: Object3D): void {
  raiz.traverse((no) => {
    if (!(no instanceof Mesh)) return;
    no.geometry.dispose();
    const materiais: Material[] = Array.isArray(no.material) ? no.material : [no.material];
    for (const material of materiais) {
      if (material instanceof MeshBasicMaterial) material.map?.dispose();
      material.dispose();
    }
  });
}
