export const STICKER_THIEF_PLUGIN_ID = 'official.sticker-thief';
export const STICKER_THIEF_NAMESPACE = 'official.sticker-thief';
export const STICKER_THIEF_VERSION = '0.3.0';
export const STICKER_THIEF_CORE_API_RANGE = '^0.3.17';
export const STICKER_THIEF_DATABASE = 'stickers';
export const STICKER_THIEF_DIGEST_JOB = 'sticker-thief.digest';
export const STICKER_THIEF_DELIVER_JOB = 'sticker-thief.deliver';
export const STICKER_THIEF_BACKFILL_JOB = 'sticker-thief.backfill';
/** Stickers sent per batch; larger deliveries continue in follow-up jobs so WhatsApp is not flooded. */
export const DELIVERY_BATCH_SIZE = 10;
export const DELIVERY_BATCH_SPACING_MS = 30_000;
/** WhatsApp sticker packs hold up to 30 stickers; smaller leftovers are sent individually. */
export const STICKER_PACK_MAX = 30;
export const STICKER_PACK_MIN = 3;
export const STICKER_PACK_SPACING_MS = 15_000;
export const STICKER_PACK_PUBLISHER = 'Sticker Thief';
export const BACKFILL_PAGE_SIZE = 50;
export const BACKFILL_PAGE_SPACING_MS = 5_000;
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
