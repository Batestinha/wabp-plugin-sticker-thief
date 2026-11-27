import type { ManagedGroupPlugin } from '@wabs/plugin-sdk/managed-group-plugin';
import { digestRegistration } from './subscriptions';
import { registerStickerThiefCommands } from './commands';
import { registerStickerThiefConsoleOperations } from './consoleOperations';
import { registerStickerThiefExternalActions } from './externalActions';
import { createStickerThiefHooks } from './hooks';
import { stickerThiefManifest } from './manifest';

export const stickerThiefPlugin: ManagedGroupPlugin = {
  manifest: stickerThiefManifest,
  registerServices: ctx => [digestRegistration(ctx)],
  registerCommands(context) {
    registerStickerThiefCommands(context);
  },
  registerHooks(context) {
    return createStickerThiefHooks(context);
  },
  registerExternalActions: registerStickerThiefExternalActions,
  registerConsoleOperations: registerStickerThiefConsoleOperations
};

export default stickerThiefPlugin;
