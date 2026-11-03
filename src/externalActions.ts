import { z } from 'zod';
import type { PluginExternalActionRegistration } from '@wabs/plugin-sdk/external-actions';
import type { PluginOperatorActionContext } from '@wabs/plugin-sdk/operator-actions';
import { STICKER_THIEF_REIMPORT_ACTION_ID } from './constants';
import { reimportArchive, type StickerThiefDeps } from './service';

// The console also sends its own envelope fields; only the scope matters here.
export const reimportArchiveInputSchema = z.object({ scopeId: z.string().trim().min(1) }).passthrough();

export function registerStickerThiefExternalActions(context: PluginOperatorActionContext): PluginExternalActionRegistration<unknown, unknown>[] {
  return [{
    actionId: STICKER_THIEF_REIMPORT_ACTION_ID,
    inputSchema: z.unknown(),
    outputSchema: z.record(z.unknown()),
    resolveScopeId: (input) => reimportArchiveInputSchema.safeParse(input).data?.scopeId,
    handler: async (body: unknown) => {
      const { scopeId } = reimportArchiveInputSchema.parse(body);
      const result = await reimportArchive(context as StickerThiefDeps, scopeId);
      await context.audit.record({
        scopeId,
        action: 'sticker-thief.reimport_archive',
        targetJson: { pluginId: context.pluginId, scopeId },
        metadataJson: { queued: result.queued, reason: result.reason ?? null, collected: result.collected ?? null, imported: result.imported ?? null }
      });
      return result;
    }
  }];
}
