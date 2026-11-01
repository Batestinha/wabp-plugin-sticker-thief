export const STICKER_THIEF_PLUGIN_ID = 'official.sticker-thief';
export const STICKER_THIEF_NAMESPACE = 'official.sticker-thief';
export const STICKER_THIEF_VERSION = '0.1.0';
export const STICKER_THIEF_CORE_API_RANGE = '^0.3.15';
export const STICKER_THIEF_DATABASE = 'stickers';
export const STICKER_THIEF_DIGEST_JOB = 'sticker-thief.digest';
export const STICKER_THIEF_MANAGE_PERMISSION = 'sticker-thief.manage';
export const STICKER_MIME_TYPE = 'image/webp';

export const CADENCE_INTERVAL_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
} as const;

export type Cadence = keyof typeof CADENCE_INTERVAL_MS;

export function isCadence(value: string | undefined): value is Cadence {
  return value === 'daily' || value === 'weekly';
}
