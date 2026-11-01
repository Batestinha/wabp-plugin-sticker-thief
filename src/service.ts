import type { PluginAction } from '@wabs/plugin-sdk/actions';
import type { PluginDatabase, PluginDatabaseRegistry } from '@wabs/plugin-sdk/database';
import type { PluginJobInput } from '@wabs/plugin-sdk/jobs';
import type { PluginMediaStore } from '@wabs/plugin-sdk/media-store';
import type { NormalizedMessage } from '@wabs/plugin-sdk/transport';
import { parseSerializedWhatsAppMessageId } from '@wabs/plugin-sdk/message-ids';
import { parseStickerThiefConfig, type StickerThiefConfig } from './config';
import { STICKER_MIME_TYPE, STICKER_THIEF_DATABASE, STICKER_THIEF_DIGEST_JOB } from './constants';
import {
  dropStickerEverywhere,
  isKnownSighting,
  recordDeliveries,
  recordSticker,
  selectStickers,
  type RecordStickerResult,
  type StickerRow,
  type SubscriptionRow
} from './store';
import { parseWebPInfo } from './webp';

export interface StickerThiefDeps {
  databases?: PluginDatabaseRegistry | undefined;
  mediaStore?: PluginMediaStore | undefined;
  enqueuePluginJob?: ((input: PluginJobInput) => Promise<unknown>) | undefined;
  configFor?: ((scopeId: string, actorIdentityId?: string | undefined) => Promise<Record<string, unknown>>) | undefined;
  now?: (() => Date) | undefined;
}

export function nowFrom(deps: StickerThiefDeps): Date {
  return deps.now?.() ?? new Date();
}

export function stickerDatabase(deps: StickerThiefDeps): PluginDatabase | undefined {
  return deps.databases?.open(STICKER_THIEF_DATABASE);
}

export async function configFor(deps: StickerThiefDeps, scopeId: string, actorIdentityId?: string): Promise<StickerThiefConfig> {
  return parseStickerThiefConfig(deps.configFor ? await deps.configFor(scopeId, actorIdentityId) : {});
}

/** The stanza id is stable across the serialized forms WhatsApp ids take, so quotes can find the sighting. */
export function stanzaIdOf(messageId: string): string {
  return parseSerializedWhatsAppMessageId(messageId)?.stanzaId ?? messageId;
}

export type CollectOutcome =
  | { kind: 'skipped'; reason: string }
  | RecordStickerResult;

/** Saves a newly seen group sticker. Never emits chat actions: collecting is silent. */
export async function collectSticker(deps: StickerThiefDeps, scopeId: string, message: NormalizedMessage): Promise<CollectOutcome> {
  if (message.type !== 'sticker' || message.fromMe || message.context !== 'group' || message.isHistoryMessage) {
    return { kind: 'skipped', reason: 'not-a-live-group-sticker' };
  }
  const config = await configFor(deps, scopeId);
  if (!config.enabled || !config.collect) return { kind: 'skipped', reason: 'collection-disabled' };
  const declaredMime = message.media?.mimeType ?? message.mediaMimeType;
  if (declaredMime && declaredMime.split(';')[0]?.trim().toLowerCase() !== STICKER_MIME_TYPE) {
    return { kind: 'skipped', reason: 'unsupported-sticker-format' };
  }
  if ((message.media?.sizeBytes ?? 0) > config.maxStickerBytes) return { kind: 'skipped', reason: 'too-large' };
  const db = stickerDatabase(deps);
  if (!db || !deps.mediaStore) return { kind: 'skipped', reason: 'storage-unavailable' };
  const stanzaId = stanzaIdOf(message.id);
  if (isKnownSighting(db, scopeId, stanzaId)) return { kind: 'skipped', reason: 'already-recorded' };

  const staged = await deps.mediaStore.stageMessage(message.id, {
    fallbackFilename: `${stanzaId}.webp`,
    maxBytes: config.maxStickerBytes
  });
  if (!staged.ok) return { kind: 'skipped', reason: staged.reason };
  const media = staged.media;
  const stored = media.mimeType.split(';')[0]?.trim().toLowerCase() === STICKER_MIME_TYPE
    ? await deps.mediaStore.read(media.id)
    : undefined;
  const info = stored ? parseWebPInfo(stored.buffer) : undefined;
  if (!info) {
    await deps.mediaStore.delete(media.id);
    return { kind: 'skipped', reason: 'unsupported-sticker-format' };
  }
  const result = recordSticker(db, {
    scopeId,
    stanzaId,
    sha256: media.sha256,
    mediaId: media.id,
    mimeType: STICKER_MIME_TYPE,
    sizeBytes: media.sizeBytes,
    width: info.width,
    height: info.height,
    animated: info.animated,
    seenAt: nowFrom(deps)
  });
  if (result.kind !== 'new') await deps.mediaStore.delete(result.duplicateMediaId);
  return result;
}

export interface PlannedDelivery {
  actions: PluginAction[];
  stickerIds: number[];
}

/**
 * Turns selected stickers into sticker-send actions, loading bytes from the
 * media store. Stickers whose file vanished are dropped from the collection.
 */
export async function stickerSendActions(
  deps: StickerThiefDeps,
  db: PluginDatabase,
  input: { scopeId: string; identityId: string; chatId: string; stickers: StickerRow[] }
): Promise<PlannedDelivery> {
  const actions: PluginAction[] = [];
  const stickerIds: number[] = [];
  for (const sticker of input.stickers) {
    const stored = await deps.mediaStore?.read(sticker.media_id);
    if (!stored) {
      dropStickerEverywhere(db, sticker.id);
      continue;
    }
    actions.push({
      type: 'message.sendSticker',
      chatId: input.chatId,
      file: { filename: `${sticker.sha256.slice(0, 16)}.webp`, mimeType: STICKER_MIME_TYPE, buffer: stored.buffer },
      idempotencyKey: `sticker-thief:${input.scopeId}:${input.identityId}:${sticker.sha256}`
    });
    stickerIds.push(sticker.id);
  }
  return { actions, stickerIds };
}

export interface DeliverInput {
  scopeId: string;
  identityId: string;
  chatId: string;
  limit: number;
  includeAnimated: boolean;
  order: 'oldest-unseen' | 'random';
}

export async function planDelivery(deps: StickerThiefDeps, db: PluginDatabase, input: DeliverInput): Promise<PlannedDelivery> {
  const stickers = selectStickers(db, input);
  const planned = await stickerSendActions(deps, db, { ...input, stickers });
  recordDeliveries(db, input.scopeId, input.identityId, planned.stickerIds, nowFrom(deps));
  return planned;
}

export interface DigestJobPayload {
  identityId: string;
  dueAt: string;
}

export function parseDigestPayload(payload: unknown): DigestJobPayload | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const { identityId, dueAt } = payload as Record<string, unknown>;
  return typeof identityId === 'string' && identityId && typeof dueAt === 'string' && !Number.isNaN(Date.parse(dueAt))
    ? { identityId, dueAt }
    : undefined;
}

/**
 * Queues the digest for a subscription's current due time. The dedupe key
 * includes the due time, so re-seeding on restart never doubles a pending job,
 * and a lost terminal job for the same slot is replaced.
 */
export async function scheduleDigest(deps: StickerThiefDeps, subscription: Pick<SubscriptionRow, 'scope_id' | 'identity_id' | 'next_due_at'>): Promise<void> {
  if (!deps.enqueuePluginJob) throw new Error('Sticker digests need host-bound job scheduling.');
  const payload: DigestJobPayload = { identityId: subscription.identity_id, dueAt: subscription.next_due_at };
  const due = new Date(subscription.next_due_at);
  const now = nowFrom(deps);
  await deps.enqueuePluginJob({
    jobName: STICKER_THIEF_DIGEST_JOB,
    executionClass: 'maintenance',
    scopeId: subscription.scope_id,
    payload,
    runAt: due.getTime() > now.getTime() ? due : now,
    dedupeKey: `sticker-thief:digest:${subscription.scope_id}:${subscription.identity_id}:${due.getTime()}`,
    replaceRetainedTerminalJob: true
  });
}
