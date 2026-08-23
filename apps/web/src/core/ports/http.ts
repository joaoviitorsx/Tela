export type HttpResponse = { readonly status: number; readonly body: unknown };

/** `fetch` atrás de uma porta — o app nativo da Fase 3 usa outro cliente. */
export type Http = {
  post(path: string, body: unknown): Promise<HttpResponse>;
  get(path: string): Promise<HttpResponse>;
  /** Dispara e esquece, sobrevive ao unload da página. */
  beacon(path: string, body: unknown): void;
};
