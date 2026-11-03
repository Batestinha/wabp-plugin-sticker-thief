export const STICKER_THIEF_PLUGIN_ID = 'official.sticker-thief';
export const STICKER_THIEF_NAMESPACE = 'official.sticker-thief';
export const STICKER_THIEF_VERSION = '0.9.0';
/** 0.3.21 lets console operations read the plugin's stored media (sticker previews). */
export const STICKER_THIEF_CORE_API_RANGE = '^0.3.21';
export const STICKER_THIEF_DATABASE = 'stickers';
export const STICKER_THIEF_DIGEST_JOB = 'sticker-thief.digest';
export const STICKER_THIEF_DELIVER_JOB = 'sticker-thief.deliver';
export const STICKER_THIEF_BACKFILL_JOB = 'sticker-thief.backfill';
export const STICKER_THIEF_FAVORITE_JOB = 'sticker-thief.favorite';
/** Stickers favourited on the bot account per job run (the host accepts up to 30). */
export const FAVORITE_BATCH_SIZE = 20;
export const FAVORITE_BATCH_SPACING_MS = 10_000;
/** After a transport failure (for example WhatsApp waiting for the phone), favourites retry with doubling delays. */
export const FAVORITE_RETRY_BASE_MS = 5 * 60_000;
export const FAVORITE_RETRY_MAX_MS = 60 * 60_000;
/** Stickers sent per batch; larger deliveries continue in follow-up jobs so WhatsApp is not flooded. */
export const DELIVERY_BATCH_SIZE = 10;
export const DELIVERY_BATCH_SPACING_MS = 30_000;
/** WhatsApp user-created sticker packs hold up to 60 stickers; smaller leftovers are sent individually. */
export const STICKER_PACK_MAX = 60;
export const STICKER_PACK_MIN = 3;
export const STICKER_PACK_SPACING_MS = 15_000;
export const STICKER_PACK_PUBLISHER = 'Sticker Thief';
export const BACKFILL_PAGE_SIZE = 50;
export const BACKFILL_PAGE_SPACING_MS = 5_000;
/** Archive media ids are random, so new stickers can only be found by listing again. */
export const BACKFILL_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const STICKER_THIEF_REIMPORT_ACTION_ID = 'official.sticker-thief.reimportArchive';
export const STICKER_THIEF_GALLERY_OPERATION_ID = 'official.sticker-thief.stickerGallery';
export const STICKER_THIEF_STICKER_IMAGE_OPERATION_ID = 'official.sticker-thief.stickerImage';
export const STICKER_THIEF_GALLERY_BUILDER_ID = 'official.sticker-thief.gallery.v1';
export const GALLERY_PAGE_DEFAULT = 60;
export const GALLERY_PAGE_MAX = 200;
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
