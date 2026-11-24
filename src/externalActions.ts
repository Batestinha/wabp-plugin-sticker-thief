import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PluginExternalActionRegistration } from '@wabs/plugin-sdk/external-actions';
import type { PluginOperatorActionContext } from '@wabs/plugin-sdk/operator-actions';
import { STICKER_PACK_PUBLISHER, STICKER_THIEF_REIMPORT_ACTION_ID, STICKER_THIEF_SEND_ARCHIVED_ACTION_ID, STICKER_THIEF_SEND_ARCHIVED_PACK_ACTION_ID, STICKER_MIME_TYPE } from './constants';
import { reimportArchive, sendArchivedSticker, sendArchivedStickerPack, type ArchivedStickerPackSendInput, type ArchivedStickerSendInput, type StickerThiefDeps } from './service';

// The console also sends its own envelope fields; only the scope matters here.
export const reimportArchiveInputSchema = z.object({ scopeId: z.string().trim().min(1) }).passthrough();

const sendArchivedStickerInputSchema = z.object({
  scopeId: z.string().trim().min(1),
  identityId: z.string().trim().min(1),
  deliveryChatId: z.string().trim().min(1),
  chatId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  groupWid: z.string().trim().min(1),
  mediaId: z.string().trim().min(1),
  stanzaId: z.string().trim().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string().trim().min(1),
  managementMode: z.string().trim().min(1),
  intent: z.enum(['offer', 'send'])
}).strict();

const sendArchivedStickerOutputSchema = z.object({
  result: z.enum(['offered', 'sent', 'already-sent', 'refused']),
  reason: z.string().optional()
}).strict();

const sendArchivedStickerPackInputSchema = z.object({
  scopeId: z.string().trim().min(1),
  identityId: z.string().trim().min(1),
  deliveryChatId: z.string().trim().min(1),
  chatId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  groupWid: z.string().trim().min(1),
  managementMode: z.string().trim().min(1),
  stanzaId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(128),
  publisher: z.string().trim().min(1).max(128).optional(),
  stickers: z.array(z.object({
    mediaId: z.string().trim().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.string().trim().min(1),
    emoji: z.string().trim().min(1).max(32).optional()
  }).strict()).min(1).max(60),
  intent: z.enum(['offer', 'send'])
}).strict();

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
  }, {
    actionId: STICKER_THIEF_SEND_ARCHIVED_ACTION_ID,
    inputSchema: sendArchivedStickerInputSchema,
    outputSchema: sendArchivedStickerOutputSchema,
    resolveScopeId: (input) => sendArchivedStickerInputSchema.safeParse(input).data?.scopeId,
    handler: async (body: unknown) => {
      const input = sendArchivedStickerInputSchema.parse(body) satisfies ArchivedStickerSendInput;
      return sendArchivedSticker(depsFrom(context), input, {
        executeSend: async (file) => {
          const operator = context.operator;
          if (!operator) throw new Error('Sticker delivery is unavailable.');
          await operator.executeActions({
            scopeId: input.scopeId,
            actorIdentityId: input.identityId,
            groupId: input.groupId,
            groupWid: input.groupWid,
            actions: [{
              type: 'message.sendSticker',
              chatId: input.deliveryChatId,
              file: { filename: `${input.sha256.slice(0, 16)}.webp`, mimeType: STICKER_MIME_TYPE, buffer: file.buffer },
              idempotencyKey: `sticker-thief:archive:v2:${input.scopeId}:${input.identityId}:${input.sha256}`
            }]
          });
        }
      });
    }
  }, {
    actionId: STICKER_THIEF_SEND_ARCHIVED_PACK_ACTION_ID,
    inputSchema: sendArchivedStickerPackInputSchema,
    outputSchema: sendArchivedStickerOutputSchema,
    resolveScopeId: (input) => sendArchivedStickerPackInputSchema.safeParse(input).data?.scopeId,
    handler: async (body: unknown) => {
      const input = sendArchivedStickerPackInputSchema.parse(body) satisfies ArchivedStickerPackSendInput;
      return sendArchivedStickerPack(depsFrom(context), input, {
        executeSend: async (pack) => {
          const operator = context.operator;
          if (!operator) throw new Error('Sticker delivery is unavailable.');
          const digest = createHash('sha256').update(pack.stickers.map((sticker) => sticker.sha256).join('\n')).digest('hex');
          await operator.executeActions({
            scopeId: input.scopeId,
            actorIdentityId: input.identityId,
            groupId: input.groupId,
            groupWid: input.groupWid,
            actions: [{
              type: 'message.sendStickerPack',
              abortBatchOnFailure: true,
              chatId: input.deliveryChatId,
              pack: {
                id: `archive-${digest.slice(0, 16)}`,
                name: pack.name,
                publisher: pack.publisher || STICKER_PACK_PUBLISHER,
                stickers: pack.stickers.map((sticker) => ({
                  file: { filename: `${sticker.sha256.slice(0, 16)}.webp`, mimeType: STICKER_MIME_TYPE, buffer: sticker.buffer },
                  ...(sticker.emoji ? { emojis: [sticker.emoji] } : {})
                }))
              },
              idempotencyKey: `sticker-thief:archive-pack:${input.scopeId}:${input.identityId}:${digest}`
            }]
          });
        }
      });
    }
  }];
}
