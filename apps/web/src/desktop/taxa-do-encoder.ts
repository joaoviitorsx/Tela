/**
 * O modo de taxa do encoder do app, vindo do ajuste experimental "Taxa
 * constante" (AJUSTES). O `useAjustes` escreve quando os ajustes chegam do
 * main; o encoder lê a cada configuração — trocar reconfigura com IDR.
 */
let constante = false;
let economia = false;

export const taxaDoEncoder = {
  /** WebCodecs: `bitrateMode` (ajuste "Taxa constante"). */
  modo: (): 'variable' | 'constant' => (constante ? 'constant' : 'variable'),
  /** NVENC nativo: `rc-mode` (ajuste "Economizar banda com a tela parada"). */
  nativo: (): 'vbr' | 'cbr' => (economia ? 'vbr' : 'cbr'),
  definir(sim: boolean): void {
    constante = sim;
  },
  definirEconomia(sim: boolean): void {
    economia = sim;
  },
};
