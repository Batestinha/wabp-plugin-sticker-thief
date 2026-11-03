import { z } from 'zod';
import type { PluginExternalActionRegistration } from '@wabs/plugin-sdk/external-actions';
import type { PluginOperatorActionContext } from '@wabs/plugin-sdk/operator-actions';
import { STICKER_THIEF_REIMPORT_ACTION_ID } from './constants';
import { reimportArchive, type StickerThiefDeps } from './service';

// The console also sends its own envelope fields; only the scope matters here.
export const reimportArchiveInputSchema = z.object({ scopeId: z.string().trim().min(1) }).passthrough();

type ActionContext = PluginOperatorActionContext & { runtimeContext?: (() => unknown) | undefined };

/** The host hands external actions the plugin's runtime context through a getter;
 * the archive, config and job queue capabilities live there, not on the context itself. */
function depsFrom(context: ActionContext): StickerThiefDeps {
  const runtime = context.runtimeContext?.();
  return { ...(context as StickerThiefDeps), ...((runtime ?? {}) as StickerThiefDeps) };
}

export function registerStickerThiefExternalActions(context: ActionContext): PluginExternalActionRegistration<unknown, unknown>[] {
  return [{
    actionId: STICKER_THIEF_REIMPORT_ACTION_ID,
    inputSchema: z.unknown(),
    outputSchema: z.record(z.unknown()),
    resolveScopeId: (input) => reimportArchiveInputSchema.safeParse(input).data?.scopeId,
    handler: async (body: unknown) => {
      const { scopeId } = reimportArchiveInputSchema.parse(body);
      const result = await reimportArchive(depsFrom(context), scopeId);
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
