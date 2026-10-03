/**
 * O modo de taxa do encoder do app, vindo do ajuste experimental "Taxa
 * constante" (AJUSTES). O `useAjustes` escreve quando os ajustes chegam do
 * main; o encoder lê a cada configuração — trocar reconfigura com IDR.
 */
let constante = false;

export const taxaDoEncoder = {
  modo: (): 'variable' | 'constant' => (constante ? 'constant' : 'variable'),
  definir(sim: boolean): void {
    constante = sim;
  },
};
