import type { PluginAction } from '@wabs/plugin-sdk/actions';
import type { PluginJobEvent, PluginRuntimeHooks } from '@wabs/plugin-sdk/hooks';
import type { StableIdentityAddressResolution } from '@wabs/plugin-sdk/identity';
import type { TranslateFn } from '@wabs/plugin-sdk/i18n';
import { STICKER_THIEF_DIGEST_JOB, STICKER_THIEF_NAMESPACE } from './constants';
import {
  collectSticker,
  configFor,
  nowFrom,
  parseDigestPayload,
  planDelivery,
  scheduleDigest,
  stickerDatabase,
  type StickerThiefDeps
} from './service';
import { advanceSubscription, deleteSubscription, getSubscription, listSubscriptions, nextDueAfter } from './store';

export interface StickerThiefHookContext extends StickerThiefDeps {
  logger?: { warn(fields: Record<string, unknown>, message: string): void } | undefined;
  i18n?: { translatorForIdentity?(identityId: string, scopeId?: string): Promise<TranslateFn> } | undefined;
  resolveStableIdentityById?: ((identityId: string) => Promise<StableIdentityAddressResolution>) | undefined;
  currentMemberIdentityIdsForScope?: ((scopeId: string) => Promise<string[]>) | undefined;
}

export function createStickerThiefHooks(context: StickerThiefHookContext): PluginRuntimeHooks {
  return {
    async onRuntimeReady() {
      const db = stickerDatabase(context);
      if (!db) return;
      for (const subscription of listSubscriptions(db)) {
        await scheduleDigest(context, subscription);
      }
    },
    async onMessage(event) {
      if (event.message.type !== 'sticker') return;
      const outcome = await collectSticker(context, event.scopeId, event.message);
      if (outcome.kind === 'skipped' && outcome.reason === 'storage-unavailable') {
        context.logger?.warn({ scopeId: event.scopeId }, 'Sticker Thief storage is unavailable; sticker not collected');
      }
    },
    async onPluginJob(job) {
      if (job.jobName !== STICKER_THIEF_DIGEST_JOB) return;
      return runDigest(context, job);
    }
  };
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
  const address = await context.resolveStableIdentityById(payload.identityId);
  const planned = await planDelivery(context, db, {
    scopeId: job.scopeId,
    identityId: payload.identityId,
    chatId: address.deliveryChatId,
    limit: config.digestSize,
    includeAnimated: config.includeAnimated,
    order: 'oldest-unseen'
  });
  if (!planned.actions.length) return;
  const t = await context.i18n?.translatorForIdentity?.(payload.identityId, job.scopeId);
  const header = t?.(`${STICKER_THIEF_NAMESPACE}.digestHeader`, { count: planned.actions.length });
  return [
    ...(header ? [{
      type: 'message.sendText' as const,
      chatId: address.deliveryChatId,
      text: header,
      idempotencyKey: `sticker-thief:digest:${job.scopeId}:${payload.identityId}:${payload.dueAt}`
    }] : []),
    ...planned.actions
  ];
}
