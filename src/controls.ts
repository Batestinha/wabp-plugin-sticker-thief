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
  control('digestSize', 'Stickers per digest', 'Most stickers sent in one scheduled digest; 0 sends every new sticker.', 50, { type: 'number', min: 0, max: 100_000 }, 'number'),
  control('manualSendLimit', 'Stickers per request', 'Stickers sent for /stickers send or /stickers random without a number; 0 sends all of them.', 60, { type: 'number', min: 0, max: 100_000 }, 'number'),
  control('deliverAsPacks', 'Send as sticker packs', 'Deliver stickers as native WhatsApp sticker packs of up to 30 (leftovers of 1-2 are sent individually). Turn off to send every sticker individually.', 62, { type: 'boolean' }, 'toggle'),
  control('backfillArchive', 'Import from chat archive', 'Also collect stickers already stored in this scope\'s chat archive.', 65, { type: 'boolean' }, 'toggle'),
  control('defaultCadence', 'Default cadence', 'Digest cadence used when a member subscribes without choosing one.', 70,
    { type: 'enum', enum: [{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }] }, 'segmented')
];

export function stickerThiefConfigPaths(): string[] {
  return Object.keys(stickerThiefConfigSchema.parse({}));
}
