import type { ManagedGroupPlugin } from '@wabs/plugin-sdk/managed-group-plugin';
import { registerStickerThiefCommands } from './commands';
import { createStickerThiefHooks } from './hooks';
import { stickerThiefManifest } from './manifest';

export const stickerThiefPlugin: ManagedGroupPlugin = {
  manifest: stickerThiefManifest,
  registerCommands(context) {
    registerStickerThiefCommands(context);
  },
  registerHooks(context) {
    return createStickerThiefHooks(context);
  }
};

export default stickerThiefPlugin;
