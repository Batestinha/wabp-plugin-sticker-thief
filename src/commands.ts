import type { CommandContext, CommandResult } from '@wabs/plugin-sdk/commands';
import { requireScopeId } from '@wabs/plugin-sdk/commands';
import type { CommandMetadata, CommandTargetSpec } from '@wabs/plugin-sdk/command-metadata';
import type { ManagedGroupCommandContext } from '@wabs/plugin-sdk/managed-group-plugin';
import type { PluginDatabase } from '@wabs/plugin-sdk/database';
import type { StickerThiefConfig } from './config';
import {
  isCadence,
  STICKER_THIEF_MANAGE_PERMISSION,
  STICKER_THIEF_NAMESPACE as ns,
  STICKER_THIEF_PLUGIN_ID
} from './constants';
import { configFor, deliverBatch, nowFrom, scheduleDigest, selectDeliveryIds, stanzaIdOf, startBackfill, startDelivery, stickerDatabase, type StickerThiefDeps } from './service';
import { backfillImported, clearDeliveries, deleteSubscription, forgetStickerBySighting, getSubscription, recentlyDeliveredIds, scopeStats, upsertSubscription } from './store';

const CHAT_FLAG_TARGET: CommandTargetSpec = { kind: 'group', name: 'chat', flag: 'chat' };
const SCOPE_TARGET: CommandTargetSpec = { kind: 'scope', flag: ['scope', 'scope-id'], fallback: 'current_scope' };

type TopicId = 'subscribe-stickers' | 'get-stickers' | 'manage-stickers';

function stickerCommand(input: {
  subcommand: string;
  topicId: TopicId;
  mutation: CommandMetadata['mutation'];
  permission?: string | undefined;
  exampleKey: string;
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: 'either_same_chat',
    pluginId: STICKER_THIEF_PLUGIN_ID,
    requiresManagedGroup: true,
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope',
    ...(input.permission ? { permission: input.permission } : {}),
    privateManagedTarget: { mode: 'infer_group_or_community', explicitTargetName: 'chat', collapseCommunities: true },
    targets: [CHAT_FLAG_TARGET, SCOPE_TARGET],
    mutation: input.mutation,
    auditAction: `sticker-thief.${input.subcommand}`,
    help: {
      familyKey: `${ns}.help.family`,
      featureId: 'stickers',
      topicId: input.topicId,
      descriptionKey: `${ns}.help.cmd.${input.subcommand}`,
      usage: `/stickers ${input.subcommand}`,
      exampleKeys: [input.exampleKey]
    }
  };
}

interface Invocation {
  scopeId: string;
  identityId: string;
  deliveryChatId: string;
}

function invocation(ctx: CommandContext): Invocation {
  const address = ctx.actor?.identityAddress;
  if (!address?.identityId) throw new Error('Authoritative actor identity is unavailable.');
  return { scopeId: requireScopeId(ctx), identityId: address.identityId, deliveryChatId: address.deliveryChatId };
}

function args(ctx: CommandContext): string[] {
  return ctx.remainingArgs ?? ctx.command.args;
}

function reply(text: string, extra: Partial<CommandResult> = {}): CommandResult {
  return { handled: true, text, ...extra };
}

/** A positive number from the command wins; otherwise the configured limit, where 0 means everything. */
function parseCount(raw: string | undefined, configured: number): number {
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : configured;
}

export function registerStickerThiefCommands(context: ManagedGroupCommandContext): void {
  const deps: StickerThiefDeps = context;
  const router = context.router;

  router.register('stickers', 'subscribe', stickerCommand({
    subcommand: 'subscribe', topicId: 'subscribe-stickers', mutation: 'durable', exampleKey: `${ns}.help.subscribe.example`
  }), async (ctx) => {
    const call = invocation(ctx);
    const config = await configFor(deps, call.scopeId, call.identityId);
    if (!config.enabled) return reply(ctx.t(`${ns}.disabled`));
    const requested = args(ctx)[0]?.toLowerCase();
    if (requested && !isCadence(requested)) return reply(ctx.t(`${ns}.subscribeUsage`));
    const db = stickerDatabase(deps);
    if (!db) return reply(ctx.t(`${ns}.unavailable`));
    const cadence = requested && isCadence(requested) ? requested : config.defaultCadence;
    const subscription = upsertSubscription(db, call.scopeId, call.identityId, cadence, nowFrom(deps));
    await scheduleDigest(deps, subscription);
    await startBackfill(deps, call.scopeId, { onlyFirstTime: true });
    const stats = scopeStats(db, call.scopeId, call.identityId, config.includeAnimated);
    return reply(ctx.t(`${ns}.subscribed`, {
      cadence: ctx.t(`${ns}.cadence.${cadence}`),
      available: stats.unseen
    }));
  });

  router.register('stickers', 'unsubscribe', stickerCommand({
    subcommand: 'unsubscribe', topicId: 'subscribe-stickers', mutation: 'durable', exampleKey: `${ns}.help.subscribe.example`
  }), async (ctx) => {
    const call = invocation(ctx);
    const db = stickerDatabase(deps);
    if (!db) return reply(ctx.t(`${ns}.unavailable`));
    return reply(ctx.t(deleteSubscription(db, call.scopeId, call.identityId) ? `${ns}.unsubscribed` : `${ns}.notSubscribed`));
  });

  router.register('stickers', 'status', stickerCommand({
    subcommand: 'status', topicId: 'subscribe-stickers', mutation: 'none', exampleKey: `${ns}.help.subscribe.example`
  }), async (ctx) => {
    const call = invocation(ctx);
    const config = await configFor(deps, call.scopeId, call.identityId);
    if (!config.enabled) return reply(ctx.t(`${ns}.disabled`));
    const db = stickerDatabase(deps);
    if (!db) return reply(ctx.t(`${ns}.unavailable`));
    const stats = scopeStats(db, call.scopeId, call.identityId, config.includeAnimated);
    const subscription = getSubscription(db, call.scopeId, call.identityId);
    return reply(ctx.t(`${ns}.status`, {
      total: stats.total,
      unseen: stats.unseen,
      archived: backfillImported(db, call.scopeId),
      subscription: subscription
        ? ctx.t(`${ns}.status.subscribed`, {
            cadence: ctx.t(`${ns}.cadence.${subscription.cadence}`),
            next: `${subscription.next_due_at.slice(0, 16).replace('T', ' ')} UTC`
          })
        : ctx.t(`${ns}.status.notSubscribed`)
    }));
  });

  async function sendStickers(ctx: CommandContext, call: Invocation, config: StickerThiefConfig, db: PluginDatabase, stickerIds: number[]): Promise<CommandResult | undefined> {
    const delivery = stickerIds.length
      ? startDelivery(db, {
          scopeId: call.scopeId, identityId: call.identityId, chatId: call.deliveryChatId, stickerIds,
          asPacks: config.deliverAsPacks,
          packName: ctx.t(`${ns}.packName`, { date: nowFrom(deps).toISOString().slice(0, 10) })
        })
      : undefined;
    const actions = delivery ? await deliverBatch(deps, db, delivery) : [];
    if (!delivery || !actions.length) return undefined;
    const key = delivery.packCount ? `${ns}.sendingPacks` : delivery.batches.length > 1 ? `${ns}.sendingBatched` : `${ns}.sending`;
    return reply(ctx.t(key, { count: stickerIds.length, packs: delivery.packCount }), { pluginActions: actions });
  }

  async function prepared(ctx: CommandContext): Promise<{ call: Invocation; config: StickerThiefConfig; db: PluginDatabase } | CommandResult> {
    const call = invocation(ctx);
    const config = await configFor(deps, call.scopeId, call.identityId);
    if (!config.enabled) return reply(ctx.t(`${ns}.disabled`));
    if (ctx.managementMode === 'OBSERVE') return reply(ctx.t(`${ns}.observeOnly`));
    const db = stickerDatabase(deps);
    if (!db || !deps.mediaStore) return reply(ctx.t(`${ns}.unavailable`));
    return { call, config, db };
  }

  for (const [subcommand, order, exampleKey] of [
    ['send', 'oldest-unseen', `${ns}.help.send.example`],
    ['random', 'random', `${ns}.help.random.example`]
  ] as const) {
    router.register('stickers', subcommand, stickerCommand({
      subcommand, topicId: 'get-stickers', mutation: 'durable', exampleKey
    }), async (ctx) => {
      const ready = await prepared(ctx);
      if ('handled' in ready) return ready;
      const { call, config, db } = ready;
      const stickerIds = selectDeliveryIds(db, {
        scopeId: call.scopeId,
        identityId: call.identityId,
        limit: parseCount(args(ctx)[0], config.manualSendLimit),
        includeAnimated: config.includeAnimated,
        order
      });
      const sent = await sendStickers(ctx, call, config, db, stickerIds);
      if (sent) return sent;
      const { total } = scopeStats(db, call.scopeId, call.identityId, config.includeAnimated);
      return reply(ctx.t(total ? `${ns}.noNewStickers` : `${ns}.noStickers`, { total }));
    });
  }

  router.register('stickers', 'resend', stickerCommand({
    subcommand: 'resend', topicId: 'get-stickers', mutation: 'durable', exampleKey: `${ns}.help.resend.example`
  }), async (ctx) => {
    const ready = await prepared(ctx);
    if ('handled' in ready) return ready;
    const { call, config, db } = ready;
    const raw = args(ctx)[0];
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    const stickerIds = recentlyDeliveredIds(db, {
      scopeId: call.scopeId, identityId: call.identityId, includeAnimated: config.includeAnimated,
      limit: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
    });
    if (!stickerIds.length) return reply(ctx.t(`${ns}.nothingToResend`));
    clearDeliveries(db, call.scopeId, call.identityId, stickerIds);
    return (await sendStickers(ctx, call, config, db, stickerIds)) ?? reply(ctx.t(`${ns}.nothingToResend`));
  });

  router.register('stickers', 'forget', stickerCommand({
    subcommand: 'forget', topicId: 'manage-stickers', mutation: 'durable',
    permission: STICKER_THIEF_MANAGE_PERMISSION, exampleKey: `${ns}.help.forget.example`
  }), async (ctx) => {
    const call = invocation(ctx);
    const quoted = ctx.message.replyTo?.messageId;
    if (!quoted) return reply(ctx.t(`${ns}.forgetUsage`));
    const db = stickerDatabase(deps);
    if (!db) return reply(ctx.t(`${ns}.unavailable`));
    const result = forgetStickerBySighting(db, call.scopeId, stanzaIdOf(quoted), call.identityId, nowFrom(deps));
    if (result.kind === 'not-found') return reply(ctx.t(`${ns}.forgetNotFound`));
    if (result.orphanMediaId) {
      // Take it out of the bot account's favourites too, while its file still exists.
      if (result.wasFavorited && deps.accountStickers) {
        const stored = await deps.mediaStore?.read(result.orphanMediaId);
        if (stored) {
          await deps.accountStickers.setFavorite({
            scopeId: call.scopeId, favorite: false,
            files: [{ filename: `${result.sha256.slice(0, 16)}.webp`, mimeType: 'image/webp', buffer: stored.buffer }]
          }).catch(() => undefined);
        }
      }
      await deps.mediaStore?.delete(result.orphanMediaId);
    }
    return reply(ctx.t(`${ns}.forgotten`), {
      pluginActions: [{ type: 'audit.record', action: 'sticker-thief.forget', targetJson: { scopeId: call.scopeId, sha256: result.sha256 } }]
    });
  });
}
