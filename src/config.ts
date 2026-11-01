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
  defaultCadence: z.enum(['daily', 'weekly']).default('daily')
}).default({});

export type StickerThiefConfig = z.infer<typeof stickerThiefConfigSchema>;

export function parseStickerThiefConfig(value: unknown): StickerThiefConfig {
  return stickerThiefConfigSchema.parse(value ?? {});
}
