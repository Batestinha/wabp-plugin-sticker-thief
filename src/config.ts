import { z } from 'zod';

export const stickerThiefConfigSchema = z.object({
  enabled: z.boolean().default(false),
  collect: z.boolean().default(true),
  includeAnimated: z.boolean().default(true),
  maxStickerBytes: z.number().int().min(1024).max(5_242_880).default(1_048_576),
  digestSize: z.number().int().min(1).max(30).default(10),
  manualSendLimit: z.number().int().min(1).max(30).default(10),
  defaultCadence: z.enum(['daily', 'weekly']).default('daily')
}).default({});

export type StickerThiefConfig = z.infer<typeof stickerThiefConfigSchema>;

export function parseStickerThiefConfig(value: unknown): StickerThiefConfig {
  return stickerThiefConfigSchema.parse(value ?? {});
}
