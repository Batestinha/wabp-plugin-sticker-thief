import { stickerThiefConfigSchema } from './config';

/** Package-level console metadata; written into wa-plugin.json by scripts/write-metadata.cjs. */
export interface StickerThiefControl {
  id: string;
  path: string;
  label: string;
  description: string;
  section: string;
  order: number;
  schema: Record<string, unknown>;
  ui: Record<string, unknown>;
}

function control(path: string, label: string, description: string, order: number, schema: Record<string, unknown>, widget: string): StickerThiefControl {
  return {
    id: `plugin.official.sticker-thief.${path}`,
    path,
    label,
    description,
    section: 'Sticker Thief',
    order,
    schema,
    ui: { widget, helpText: description }
  };
}

export const stickerThiefControls: StickerThiefControl[] = [
  control('enabled', 'Enabled', 'Turn Sticker Thief on for this scope.', 10, { type: 'boolean' }, 'toggle'),
  control('collect', 'Collect new stickers', 'Save new stickers shared in this scope\'s groups.', 20, { type: 'boolean' }, 'toggle'),
  control('includeAnimated', 'Include animated stickers', 'Send animated stickers as well as still ones.', 30, { type: 'boolean' }, 'toggle'),
  control('maxStickerBytes', 'Maximum sticker size', 'Stickers larger than this are not collected.', 40, { type: 'number', unit: 'bytes', min: 1024, max: 5_242_880 }, 'number'),
  control('digestSize', 'Stickers per digest', 'Most stickers sent in one scheduled digest.', 50, { type: 'number', min: 1, max: 30 }, 'number'),
  control('manualSendLimit', 'Stickers per request', 'Most stickers sent for one /stickers send or /stickers random.', 60, { type: 'number', min: 1, max: 30 }, 'number'),
  control('defaultCadence', 'Default cadence', 'Digest cadence used when a member subscribes without choosing one.', 70,
    { type: 'enum', enum: [{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }] }, 'segmented')
];

export function stickerThiefConfigPaths(): string[] {
  return Object.keys(stickerThiefConfigSchema.parse({}));
}
