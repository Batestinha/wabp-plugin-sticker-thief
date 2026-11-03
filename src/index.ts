import type { ManagedGroupPlugin } from '@wabs/plugin-sdk/managed-group-plugin';
import { registerStickerThiefCommands } from './commands';
import { registerStickerThiefExternalActions } from './externalActions';
import { createStickerThiefHooks } from './hooks';
import { stickerThiefManifest } from './manifest';

export const stickerThiefPlugin: ManagedGroupPlugin = {
  manifest: stickerThiefManifest,
  registerCommands(context) {
    registerStickerThiefCommands(context);
  },
  registerHooks(context) {
    return createStickerThiefHooks(context);
  },
  registerExternalActions: registerStickerThiefExternalActions
};

export default stickerThiefPlugin;
