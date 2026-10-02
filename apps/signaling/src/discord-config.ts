/**
 * ÚNICO lugar do Worker que lê as variáveis do app do Discord.
 *
 * - `DISCORD_PUBLIC_KEY` (secret): a chave pública Ed25519 do app, em hex.
 *   Sem ela, `POST /discord/interactions` responde 404 — o endpoint está
 *   desligado, não quebrado.
 * - `DISCORD_APPLICATION_ID` (var): opcional. Quando existe, interação de
 *   outro app é recusada mesmo com assinatura válida.
 *
 * O token do bot NÃO entra aqui nem em lugar nenhum do Worker: ele só serve
 * para registrar o comando, e quem registra é `scripts/discord-registrar.mjs`,
 * rodado pelo dono na máquina dele (docs/DISCORD.md).
 */
export type EnvDoDiscord = {
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
};

export type ConfigDoDiscord = {
  /** 32 bytes da chave pública Ed25519. */
  readonly chavePublica: Uint8Array;
  readonly applicationId?: string;
};

const HEX_DA_CHAVE = /^[0-9a-f]{64}$/i;
const SNOWFLAKE = /^\d{5,25}$/;

/**
 * `null` = endpoint desligado. Chave malformada também desliga, e o código
 * vai para o log — nunca o valor. Ligar um verificador com chave errada
 * recusaria tudo do mesmo jeito, só que fingindo estar configurado.
 */
export function lerConfigDoDiscord(
  env: EnvDoDiscord,
  relatar: (problema: string) => void = (problema) => console.error(problema),
): ConfigDoDiscord | null {
  const chave = env.DISCORD_PUBLIC_KEY?.trim() ?? '';
  if (chave === '') return null;
  if (!HEX_DA_CHAVE.test(chave)) {
    relatar('DISCORD_PUBLIC_KEY_INVALID');
    return null;
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(chave.slice(i * 2, i * 2 + 2), 16);

  const id = env.DISCORD_APPLICATION_ID?.trim() ?? '';
  if (id !== '' && !SNOWFLAKE.test(id)) {
    relatar('DISCORD_APPLICATION_ID_INVALID');
    return null;
  }
  return { chavePublica: bytes, ...(id === '' ? {} : { applicationId: id }) };
}
