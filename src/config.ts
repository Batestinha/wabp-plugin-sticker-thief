import { z } from 'zod';

export const stickerThiefConfigSchema = z.object({
  enabled: z.boolean().default(false),
  collect: z.boolean().default(true),
  includeAnimated: z.boolean().default(true),
  maxStickerBytes: z.number().int().min(1024).max(5_242_880).default(1_048_576),
  /** 0 sends every unseen sticker. */
  digestSize: z.number().int().min(0).max(100_000).default(0),
  /** 0 sends every matching sticker when no number is given. */
  manualSendLimit: z.number().int().min(0).max(100_000).default(0),
  backfillArchive: z.boolean().default(true),
  /** Add every collected sticker to the bot account's favourite stickers. */
  favoriteOnBotAccount: z.boolean().default(true),
  /** Send deliveries as native WhatsApp sticker packs (falls back to single stickers when off). */
  deliverAsPacks: z.boolean().default(true),
  defaultCadence: z.enum(['daily', 'weekly']).default('daily'),
  /**
   * Lines that may be posted in the group a new sticker was just collected from.
   * Empty stays quiet. Blank entries are dropped; a line longer than 500 characters is rejected.
   */
  announceMessages: z.array(z.string().max(500)).max(40).default([]).transform((items) =>
    items.map((item) => item.trim()).filter((item) => item.length > 0)),
  /** 0 never posts a group line. */
  announceChancePercent: z.number().int().min(0).max(100).default(0),
  /** Minutes before the same group can get another line. 0 allows one on every successful roll. */
  announceCooldownMinutes: z.number().int().min(0).max(43_200).default(60)
}).default({});

export type StickerThiefConfig = z.infer<typeof stickerThiefConfigSchema>;

export function parseStickerThiefConfig(value: unknown): StickerThiefConfig {
  return stickerThiefConfigSchema.parse(value ?? {});
}
