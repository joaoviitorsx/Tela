import { z } from 'zod';

/**
 * Contrato compartilhado entre o front e o servidor de sinalização.
 *
 * Encolheu muito no changeset 001: não há mais API HTTP, então não há mais
 * contrato de requisição e resposta. O que sobrou é o vocabulário que os dois
 * lados precisam concordar — slug, credencial e preset.
 */

/**
 * 3–25 chars, minúsculas/dígitos/hífen, não começa nem termina com hífen.
 *
 * FONTE ÚNICA. Foi duplicada em três lugares antes (domínio, schema e um
 * literal inline na UI), e uma ADR chegou a documentar como mudá-la citando
 * só duas das três cópias. Quem precisar validar slug importa daqui.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,23}[a-z0-9]$/;

export const SlugSchema = z.string().regex(SLUG_RE);

/** 32 bytes aleatórios em base64url = 43 chars. É a credencial; não há senha. */
export const OwnerTokenSchema = z.string().min(43).max(256);

export const PresetIdSchema = z.enum(['p1080p60', 'p720p60', 'p720p60eco', 'p720p30']);
