/**
 * Prepara o modelo da abertura para a web.
 *
 * O arquivo que sai do modelador tem 3,57 MB e 94% disso não chega à GPU:
 *
 * | O que | Bytes | Por que sai |
 * |---|---|---|
 * | `extras` dos nós | 1,31 MB | o exportador do Three despejou `Object3D.toJSON()` inteiro em cada nó — parâmetros de `ExtrudeGeometry`, UUIDs, materiais duplicados em JSON. Nada disso é lido em runtime |
  * | `NORMAL` | ~770 KB | a cena não tem luz e todo material vira unlit aqui: normal não entra em shader nenhum. E, por estarem separadas por face, elas impediam a soldagem dos vértices |
 * | float32 | ~150 KB | posição e UV cabem em inteiro quantizado (`KHR_mesh_quantization`, nativo no three.js — sem decoder no bundle) |
 *
 * Sem as normais o `weld` funde 64.334 vértices em 19.114, e o `dedup` reduz
 * 41 malhas a 28 — os contornos de casca invertida repetiam geometria.
 *
 * Meshopt (`EXT_meshopt_compression`) levaria a 126 KB, mas custa um decoder
 * de ~50 KB no bundle e um passo de descompressão antes do primeiro quadro.
 * A abertura tem 150 ms de orçamento para decidir se roda: 87 KB a mais no
 * fio (brotli) valem menos que um decoder no caminho crítico.
 *
 * Rode quando o `.glb` de origem mudar:
 *   node scripts/build-3d.mjs
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { dedup, prune, quantize, weld } from '@gltf-transform/functions';

const raiz = resolve(import.meta.dirname, '..');
const origem = resolve(raiz, 'assets/3d/tela-crt.origem.glb');
const destino = resolve(raiz, 'apps/web/public/tela-crt.glb');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(origem);

/**
 * Todo material vira `KHR_materials_unlit`.
 *
 * No arquivo de origem só `chiado` e os 11 `contorno_*` eram unlit; gabinete,
 * moldura, antena, LEDs e placa saíram como PBR. Numa cena sem luz — e a cena
 * da abertura não tem luz, de propósito — PBR renderiza PRETO. O aparelho
 * inteiro virava uma silhueta.
 *
 * A saída não é acrescentar luz: é assumir o que o modelo já é. Cel shading
 * aqui é cor chapada mais contorno de casca invertida, os `contorno_*` que
 * vieram modelados. Luz direcional traria justamente o degradê que a §11 da
 * documentação técnica proíbe no produto inteiro ("zero sombras, zero
 * gradientes"), e ainda exigiria as normais de volta.
 *
 * Efeito colateral bom: o shader de `MeshStandardMaterial` nunca é compilado.
 * São menos alguns milissegundos no quadro de aquecimento, que é exatamente o
 * número que decide se a coreografia roda (§2, passo 4).
 */
const unlit = doc.createExtension(KHRMaterialsUnlit).setRequired(false);
for (const material of doc.getRoot().listMaterials()) {
  material.setExtension('KHR_materials_unlit', unlit.createUnlit());
}

// Sem luz, normal e tangente não chegam a shader nenhum — e, por estarem
// separadas por face, elas impediam a soldagem dos vértices.
for (const mesh of doc.getRoot().listMeshes())
  for (const prim of mesh.listPrimitives()) {
    prim.setAttribute('NORMAL', null);
    prim.setAttribute('TANGENT', null);
  }

for (const prop of [
  doc.getRoot(),
  ...doc.getRoot().listNodes(),
  ...doc.getRoot().listMeshes(),
  ...doc.getRoot().listMaterials(),
  ...doc.getRoot().listScenes(),
])
  prop.setExtras({});

await doc.transform(
  weld(),
  dedup(),
  prune(),
  quantize({ quantizePosition: 14, quantizeTexcoord: 12 }),
);

await io.write(destino, doc);

/**
 * Os nomes de nó são contrato com `adapters/three-crt-stage.ts`: é por
 * `vidro_tubo` e `tubo_chiado` que o shader da tela encontra onde pintar. Uma
 * ferramenta que renomeie ou funda esses nós quebra a abertura em silêncio —
 * a cena carrega, o tubo aparece e a tela fica preta.
 */
const EXIGIDOS = ['vidro_tubo', 'tubo_chiado', 'Tela_CRT'];
const nomes = new Set(doc.getRoot().listNodes().map((n) => n.getName()));
const faltando = EXIGIDOS.filter((nome) => !nomes.has(nome));
if (faltando.length > 0) {
  console.error(`Nós obrigatórios sumiram do modelo: ${faltando.join(', ')}`);
  process.exit(1);
}

const antes = statSync(origem).size;
const depois = statSync(destino).size;
const brotli = readFileSync(destino).length;
console.log(
  `tela-crt.glb  ${(antes / 1024).toFixed(0)} KB → ${(depois / 1024).toFixed(0)} KB ` +
    `(${(100 - (brotli / antes) * 100).toFixed(0)}% menor) · ${nomes.size} nós preservados`,
);
