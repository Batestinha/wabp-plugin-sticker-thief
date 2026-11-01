import type { PluginAction } from '@wabs/plugin-sdk/actions';
import type { PluginJobEvent, PluginRuntimeHooks } from '@wabs/plugin-sdk/hooks';
import type { StableIdentityAddressResolution } from '@wabs/plugin-sdk/identity';
import type { TranslateFn } from '@wabs/plugin-sdk/i18n';
import type { PluginEnabledScope } from '@wabs/plugin-sdk/integration-plugin';
import {
  STICKER_THIEF_BACKFILL_JOB,
  STICKER_THIEF_DELIVER_JOB,
  STICKER_THIEF_DIGEST_JOB,
  STICKER_THIEF_FAVORITE_JOB,
  STICKER_THIEF_NAMESPACE
} from './constants';
import {
  collectSticker,
  configFor,
  deliverBatch,
  nowFrom,
  parseDeliveryPayload,
  parseDigestPayload,
  runBackfillPage,
  runFavorites,
  scheduleFavorites,
  scheduleDigest,
  selectDeliveryIds,
  startBackfill,
  startDelivery,
  stickerDatabase,
  type StickerThiefDeps
} from './service';
import { advanceSubscription, deleteSubscription, getSubscription, listSubscriptions, nextDueAfter } from './store';

export interface StickerThiefHookContext extends StickerThiefDeps {
  logger?: { warn(fields: Record<string, unknown>, message: string): void } | undefined;
  i18n?: { translatorForIdentity?(identityId: string, scopeId?: string): Promise<TranslateFn> } | undefined;
  resolveStableIdentityById?: ((identityId: string) => Promise<StableIdentityAddressResolution>) | undefined;
  currentMemberIdentityIdsForScope?: ((scopeId: string) => Promise<string[]>) | undefined;
  listEnabledScopes?: (() => Promise<PluginEnabledScope[]>) | undefined;
}

export function createStickerThiefHooks(context: StickerThiefHookContext): PluginRuntimeHooks {
  return {
    async onRuntimeReady() {
      const db = stickerDatabase(context);
      if (!db) return;
      for (const subscription of listSubscriptions(db)) {
        await scheduleDigest(context, subscription);
      }
      for (const scope of await context.listEnabledScopes?.() ?? []) {
        await startBackfill(context, scope.scopeId).catch((error: unknown) => {
          context.logger?.warn({ scopeId: scope.scopeId, error: String(error) }, 'Sticker Thief could not start the archive backfill');
        });
        // Catches up stickers collected before favourites existed or while they failed.
        await scheduleFavorites(context, scope.scopeId).catch((error: unknown) => {
          context.logger?.warn({ scopeId: scope.scopeId, error: String(error) }, 'Sticker Thief could not schedule bot favourites');
        });
      }
    },
    async onMessage(event) {
      // The first message seen in a newly enabled scope starts its archive backfill.
      await startBackfill(context, event.scopeId, { onlyFirstTime: true });
      if (event.message.type !== 'sticker') return;
      const outcome = await collectSticker(context, event.scopeId, event.message);
      if (outcome.kind === 'new') await scheduleFavorites(context, event.scopeId);
      if (outcome.kind === 'skipped' && outcome.reason === 'storage-unavailable') {
        context.logger?.warn({ scopeId: event.scopeId }, 'Sticker Thief storage is unavailable; sticker not collected');
      }
    },
    async onPluginJob(job) {
      if (job.jobName === STICKER_THIEF_DIGEST_JOB) return runDigest(context, job);
      if (job.jobName === STICKER_THIEF_DELIVER_JOB) return runDeliveryBatch(context, job);
      if (job.jobName === STICKER_THIEF_FAVORITE_JOB) {
        await runFavorites(context, job.scopeId);
        return;
      }
      if (job.jobName === STICKER_THIEF_BACKFILL_JOB) {
        await runBackfillPage(context, job.scopeId);
      }
    }
  };
}

export async function runDeliveryBatch(context: StickerThiefHookContext, job: PluginJobEvent): Promise<PluginAction[] | void> {
  const payload = parseDeliveryPayload(job.payload);
  const db = stickerDatabase(context);
  if (!payload || !db || job.managementMode === 'OBSERVE') return;
  if (!(await configFor(context, job.scopeId, payload.identityId)).enabled) return;
  return deliverBatch(context, db, { ...payload, scopeId: job.scopeId });
}

function packName(t: TranslateFn | undefined, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return t?.(`${STICKER_THIEF_NAMESPACE}.packName`, { date }) ?? `Sticker Thief ${date}`;
}

export async function runDigest(context: StickerThiefHookContext, job: PluginJobEvent): Promise<PluginAction[] | void> {
  const payload = parseDigestPayload(job.payload);
  const db = stickerDatabase(context);
  if (!payload || !db) return;
  const subscription = getSubscription(db, job.scopeId, payload.identityId);
  // A newer subscribe/unsubscribe superseded this job's slot.
  if (!subscription || subscription.next_due_at !== payload.dueAt) return;

  if (context.currentMemberIdentityIdsForScope) {
    const members = await context.currentMemberIdentityIdsForScope(job.scopeId);
    if (!members.includes(payload.identityId)) {
      deleteSubscription(db, job.scopeId, payload.identityId);
      return [{ type: 'audit.record', action: 'sticker-thief.subscription.ended', targetJson: { scopeId: job.scopeId }, metadataJson: { reason: 'left-scope' } }];
    }
  }

  const now = nowFrom(context);
  const next = nextDueAfter(new Date(subscription.next_due_at), subscription.cadence, now);
  advanceSubscription(db, job.scopeId, payload.identityId, next);
  await scheduleDigest(context, { scope_id: job.scopeId, identity_id: payload.identityId, next_due_at: next.toISOString() });

  const config = await configFor(context, job.scopeId, payload.identityId);
  if (!config.enabled || job.managementMode === 'OBSERVE' || !context.resolveStableIdentityById) return;
  const stickerIds = selectDeliveryIds(db, {
    scopeId: job.scopeId,
    identityId: payload.identityId,
    limit: config.digestSize,
    includeAnimated: config.includeAnimated,
    order: 'oldest-unseen'
  });
  if (!stickerIds.length) return;
  const address = await context.resolveStableIdentityById(payload.identityId);
  const t = await context.i18n?.translatorForIdentity?.(payload.identityId, job.scopeId);
  const actions = await deliverBatch(context, db, startDelivery(db, {
    scopeId: job.scopeId, identityId: payload.identityId, chatId: address.deliveryChatId, stickerIds,
    asPacks: config.deliverAsPacks, packName: packName(t, now)
  }));
  if (!actions.length) return;
  const header = t?.(`${STICKER_THIEF_NAMESPACE}.digestHeader`, { count: stickerIds.length });
  return [
    ...(header ? [{
      type: 'message.sendText' as const,
      chatId: address.deliveryChatId,
      text: header,
      idempotencyKey: `sticker-thief:digest:${job.scopeId}:${payload.identityId}:${payload.dueAt}`
    }] : []),
    ...actions
  ];
}
