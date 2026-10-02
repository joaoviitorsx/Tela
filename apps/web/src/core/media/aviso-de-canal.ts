import type { ViewerState } from './viewer-session.js';

/**
 * Em que pé está o canal, do ponto de vista de quem espera (V-03, V-04).
 *
 * - `esperando`: nunca houve imagem nesta aba.
 * - `ao-vivo`: a imagem está chegando.
 * - `encerrada`: já houve imagem e ela acabou. Fica assim até voltar ao ar,
 *   mesmo enquanto a sessão tenta de novo em segundo plano: sem isso a tela
 *   piscaria entre "encerrada" e "conectando" a cada sondagem.
 */
export type FaseDoCanal = 'esperando' | 'ao-vivo' | 'encerrada';

export type RegistroDoCanal = {
  readonly fase: FaseDoCanal;
  /** Instante (ms, relógio da página) em que a imagem parou; `null` fora de `encerrada`. */
  readonly terminouEm: number | null;
};

export const REGISTRO_INICIAL: RegistroDoCanal = { fase: 'esperando', terminouEm: null };

/**
 * Estados em que NÃO se sabe nada de novo sobre o fim do canal: a sessão está
 * apenas tentando de novo ou parou por outra razão (cheio, sem servidor…).
 * Nesses a fase anterior vale.
 */
export function proximoRegistro(
  anterior: RegistroDoCanal,
  status: ViewerState['status'],
  temImagem: boolean,
  agora: number,
): RegistroDoCanal {
  if (status === 'watching' || (status === 'reconnecting' && temImagem)) {
    return anterior.fase === 'ao-vivo' ? anterior : { fase: 'ao-vivo', terminouEm: null };
  }
  // A imagem existia e a sessão voltou a procurar o canal: o transmissor saiu.
  if (anterior.fase === 'ao-vivo' && status === 'offline') {
    return { fase: 'encerrada', terminouEm: agora };
  }
  return anterior;
}

/** O título da aba. O ponto e os glifos são o que o olho procura entre trinta abas. */
export function tituloDaAba(slug: string, fase: FaseDoCanal): string {
  switch (fase) {
    case 'ao-vivo':
      return `● AO VIVO · ${slug}`;
    case 'encerrada':
      return `■ encerrada · ${slug}`;
    case 'esperando':
      return `◌ aguardando · ${slug}`;
  }
}

/** "21:07", no fuso de quem olha. */
export function horaCurta(instante: number): string {
  return new Date(instante).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Só se avisa por som quando a imagem ACABOU de chegar numa aba que esperava. */
export function deveBipar(anterior: FaseDoCanal, atual: FaseDoCanal): boolean {
  return atual === 'ao-vivo' && anterior !== 'ao-vivo';
}
