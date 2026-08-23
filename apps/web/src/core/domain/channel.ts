import type { Slug } from './slug.js';

/**
 * Nome do canal no servidor de sinalização.
 *
 * Era "room" quando havia um SFU com salas de verdade. Em mesh não existe sala
 * — existe um canal de sinalização por slug, e a mídia não passa por ele. O
 * nome mudou junto com a arquitetura (changeset 001).
 */
declare const channelBrand: unique symbol;
export type ChannelName = string & { readonly [channelBrand]: true };

export function channelFor(slug: Slug): ChannelName {
  return slug as string as ChannelName;
}

export function unsafeChannelName(raw: string): ChannelName {
  return raw as ChannelName;
}
