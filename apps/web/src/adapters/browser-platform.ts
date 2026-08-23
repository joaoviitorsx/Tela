import type { Platform, SystemAudioMode } from '../core/ports/platform.js';

/**
 * Detecção de sistema operacional.
 *
 * `userAgentData.platform` é o caminho moderno e não é congelado pela redução
 * de entropia do User-Agent; o `userAgent` fica como reserva para quem ainda
 * não o expõe (Firefox, Safari).
 */
type UserAgentData = { platform?: string };

export function makeBrowserPlatform(): Platform {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const data = (nav as (Navigator & { userAgentData?: UserAgentData }) | undefined)?.userAgentData;
  const raw = (data?.platform ?? nav?.userAgent ?? '').toLowerCase();

  const os: ReturnType<Platform['osName']> = raw.includes('win')
    ? 'windows'
    : raw.includes('mac')
      ? 'macos'
      : raw.includes('linux') || raw.includes('x11') || raw.includes('cros')
        ? 'linux'
        : 'desconhecido';

  const audio: SystemAudioMode =
    os === 'windows'
      ? 'display-media'
      : os === 'linux'
        ? 'monitor-device'
        : // macOS precisa de driver de terceiro; desconhecido é tratado como
          // macOS de propósito — prometer áudio e entregar silêncio é pior que
          // avisar que não dá.
          'unsupported';

  return {
    systemAudio: () => audio,
    osName: () => os,
  };
}
