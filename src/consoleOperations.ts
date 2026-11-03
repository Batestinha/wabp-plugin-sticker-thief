import { z } from 'zod';
import type { PluginConsoleContext, PluginConsoleOperationRegistration } from '@wabs/plugin-sdk/console-operations';
import { parseStickerThiefConfig } from './config';
import {
  GALLERY_PAGE_DEFAULT,
  GALLERY_PAGE_MAX,
  STICKER_THIEF_DATABASE,
  STICKER_THIEF_GALLERY_OPERATION_ID,
  STICKER_THIEF_STICKER_IMAGE_OPERATION_ID
} from './constants';
import { favoriteState, galleryCounts, listGallery, stickerInScope, type GalleryFilter, type GalleryStickerRow } from './store';

const galleryInputSchema = z.object({
  scopeId: z.string().trim().min(1),
  filter: z.enum(['all', 'favorited', 'pending']).default('all'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(GALLERY_PAGE_MAX).default(GALLERY_PAGE_DEFAULT)
});

const stickerImageInputSchema = z.object({
  scopeId: z.string().trim().min(1),
  stickerId: z.coerce.number().int().positive()
});

export interface GalleryStickerView {
  id: number;
  mediaId: string;
  mimeType: string;
  animated: boolean;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  favoritedAt: string | null;
}

export interface GalleryView {
  scopeId: string;
  favoritesEnabled: boolean;
  counts: { collected: number; favorited: number; pending: number };
  favoriteState: {
    status: 'idle' | 'waiting';
    failingSince: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    nextRetryAt: string | null;
    attempts: number;
  };
  filter: GalleryFilter;
  offset: number;
  limit: number;
  total: number;
  stickers: GalleryStickerView[];
}

/** Read-only console operations: the sticker gallery and one sticker's stored image. */
export function registerStickerThiefConsoleOperations(context: PluginConsoleContext): PluginConsoleOperationRegistration[] {
  return [
    { operationId: STICKER_THIEF_GALLERY_OPERATION_ID, handler: (input) => stickerGallery(context, input) },
    { operationId: STICKER_THIEF_STICKER_IMAGE_OPERATION_ID, handler: (input) => stickerImage(context, input) }
  ];
}

export async function stickerGallery(context: PluginConsoleContext, rawInput: unknown): Promise<GalleryView> {
  const input = galleryInputSchema.parse(rawInput ?? {});
  await context.assertScope(input.scopeId);
  const config = parseStickerThiefConfig(await context.configuration.resolve(input.scopeId));
  const db = context.openDatabases().open(STICKER_THIEF_DATABASE);
  const page = listGallery(db, input);
  const state = favoriteState(db, input.scopeId);
  return {
    scopeId: input.scopeId,
    favoritesEnabled: Boolean(config.enabled && config.favoriteOnBotAccount),
    counts: galleryCounts(db, input.scopeId),
    favoriteState: {
      status: state ? 'waiting' : 'idle',
      failingSince: state?.failing_since ?? null,
      lastError: state?.last_error ?? null,
      lastErrorAt: state?.last_error_at ?? null,
      nextRetryAt: state?.next_retry_at ?? null,
      attempts: state?.attempts ?? 0
    },
    filter: input.filter,
    offset: input.offset,
    limit: input.limit,
    total: page.total,
    stickers: page.rows.map(stickerView)
  };
}

export async function stickerImage(context: PluginConsoleContext, rawInput: unknown): Promise<{ filename: string; mimeType: string; sha256: string; bodyBase64: string }> {
  const input = stickerImageInputSchema.parse(rawInput ?? {});
  await context.assertScope(input.scopeId);
  if (!context.mediaStore) throw consoleError(501, 'This WABP version cannot show stored stickers.');
  const db = context.openDatabases().open(STICKER_THIEF_DATABASE);
  const sticker = stickerInScope(db, input.scopeId, input.stickerId);
  if (!sticker) throw consoleError(404, 'That sticker is not collected in this scope.');
  const stored = await context.mediaStore.read(sticker.media_id);
  if (!stored) throw consoleError(404, 'The sticker file is no longer stored.');
  return {
    filename: `${sticker.sha256.slice(0, 16)}.webp`,
    mimeType: stored.media.mimeType || sticker.mime_type,
    sha256: sticker.sha256,
    bodyBase64: stored.buffer.toString('base64')
  };
}

function stickerView(row: GalleryStickerRow): GalleryStickerView {
  return {
    id: Number(row.id),
    mediaId: row.media_id,
    mimeType: row.mime_type,
    animated: Number(row.animated) === 1,
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    sizeBytes: Number(row.size_bytes),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    seenCount: Number(row.seen_count),
    favoritedAt: row.favorited_at
  };
}

function consoleError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
