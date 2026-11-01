import { randomUUID } from 'node:crypto';
import type { PluginAction } from '@wabs/plugin-sdk/actions';
import type { PluginArchivedStickers } from '@wabs/plugin-sdk/chat-archive';
import type { PluginDatabase, PluginDatabaseRegistry } from '@wabs/plugin-sdk/database';
import type { PluginCoveredGroup } from '@wabs/plugin-sdk/hook-plugin';
import type { PluginJobInput } from '@wabs/plugin-sdk/jobs';
import type { PluginMediaStore, PluginStagedMedia } from '@wabs/plugin-sdk/media-store';
import type { NormalizedMessage } from '@wabs/plugin-sdk/transport';
import { parseSerializedWhatsAppMessageId } from '@wabs/plugin-sdk/message-ids';
import { parseStickerThiefConfig, type StickerThiefConfig } from './config';
import {
  BACKFILL_PAGE_SIZE,
  BACKFILL_PAGE_SPACING_MS,
  DELIVERY_BATCH_SIZE,
  DELIVERY_BATCH_SPACING_MS,
  STICKER_MIME_TYPE,
  STICKER_PACK_MAX,
  STICKER_PACK_MIN,
  STICKER_PACK_PUBLISHER,
  STICKER_PACK_SPACING_MS,
  STICKER_THIEF_BACKFILL_JOB,
  STICKER_THIEF_DATABASE,
  STICKER_THIEF_DELIVER_JOB,
  STICKER_THIEF_DIGEST_JOB
} from './constants';
import {
  advanceBackfillChat,
  backfillChat,
  completeBackfill,
  dropStickerEverywhere,
  isKnownSighting,
  recordDeliveries,
  recordKnownSticker,
  recordSticker,
  requestBackfill,
  selectStickers,
  stickersByIds,
  type RecordStickerResult,
  type SubscriptionRow
} from './store';
import { parseWebPInfo } from './webp';

export interface StickerThiefDeps {
  databases?: PluginDatabaseRegistry | undefined;
  mediaStore?: PluginMediaStore | undefined;
  archivedStickers?: PluginArchivedStickers | undefined;
  coveredGroupsForScope?: ((scopeId: string) => Promise<PluginCoveredGroup[]>) | undefined;
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

function enqueue(deps: StickerThiefDeps, input: PluginJobInput): Promise<unknown> {
  if (!deps.enqueuePluginJob) throw new Error('Sticker Thief needs host-bound job scheduling.');
  return deps.enqueuePluginJob(input);
}

function isWebP(mimeType: string | undefined): boolean {
  return mimeType?.split(';')[0]?.trim().toLowerCase() === STICKER_MIME_TYPE;
}

export type CollectOutcome =
  | { kind: 'skipped'; reason: string }
  | RecordStickerResult;

/** Validates staged bytes as WebP and records them, deleting the staged copy when it is a duplicate or invalid. */
async function recordStaged(
  deps: StickerThiefDeps,
  db: PluginDatabase,
  input: { scopeId: string; stanzaId: string; media: PluginStagedMedia; seenAt: Date }
): Promise<CollectOutcome> {
  const stored = isWebP(input.media.mimeType) ? await deps.mediaStore?.read(input.media.id) : undefined;
  const info = stored ? parseWebPInfo(stored.buffer) : undefined;
  if (!info) {
    await deps.mediaStore?.delete(input.media.id);
    return { kind: 'skipped', reason: 'unsupported-sticker-format' };
  }
  const result = recordSticker(db, {
    scopeId: input.scopeId,
    stanzaId: input.stanzaId,
    sha256: input.media.sha256,
    mediaId: input.media.id,
    mimeType: STICKER_MIME_TYPE,
    sizeBytes: input.media.sizeBytes,
    width: info.width,
    height: info.height,
    animated: info.animated,
    seenAt: input.seenAt
  });
  if (result.kind !== 'new') await deps.mediaStore?.delete(result.duplicateMediaId);
  return result;
}

/** Saves a newly seen group sticker. Never emits chat actions: collecting is silent. */
export async function collectSticker(deps: StickerThiefDeps, scopeId: string, message: NormalizedMessage): Promise<CollectOutcome> {
  if (message.type !== 'sticker' || message.fromMe || message.context !== 'group' || message.isHistoryMessage) {
    return { kind: 'skipped', reason: 'not-a-live-group-sticker' };
  }
  const config = await configFor(deps, scopeId);
  if (!config.enabled || !config.collect) return { kind: 'skipped', reason: 'collection-disabled' };
  const declaredMime = message.media?.mimeType ?? message.mediaMimeType;
  if (declaredMime && !isWebP(declaredMime)) return { kind: 'skipped', reason: 'unsupported-sticker-format' };
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
  return recordStaged(deps, db, { scopeId, stanzaId, media: staged.media, seenAt: nowFrom(deps) });
}

// ---------------------------------------------------------------------------
// Delivery: no overall cap. A request is planned up front into batches that
// follow-up jobs send one at a time: native sticker packs (up to 30 stickers,
// still and animated kept apart) or, for leftovers and when packs are off,
// single stickers in groups of DELIVERY_BATCH_SIZE.
// ---------------------------------------------------------------------------

export interface DeliverySelection {
  scopeId: string;
  identityId: string;
  /** 0 means no limit. */
  limit: number;
  includeAnimated: boolean;
  order: 'oldest-unseen' | 'random';
}

export function selectDeliveryIds(db: PluginDatabase, input: DeliverySelection): number[] {
  return selectStickers(db, input).map((row) => Number(row.id));
}

export interface DeliveryBatch {
  pack: boolean;
  ids: number[];
}

export interface DeliveryJobPayload {
  identityId: string;
  chatId: string;
  /** Unique per request; part of every idempotency key so retries dedupe but later requests always send. */
  deliveryId: string;
  batches: DeliveryBatch[];
  /** Shown as the pack name; numbered when a delivery has several packs. */
  packName: string;
  packCount: number;
  /** Packs already sent in this delivery, used for pack ids and numbering. */
  packsSent: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Plans the whole delivery: packs per sticker kind, singles for small leftovers. */
export function planDeliveryBatches(db: PluginDatabase, scopeId: string, stickerIds: number[], asPacks: boolean): DeliveryBatch[] {
  if (!asPacks) return chunk(stickerIds, DELIVERY_BATCH_SIZE).map((ids) => ({ pack: false, ids }));
  const rows = stickersByIds(db, scopeId, stickerIds);
  const batches: DeliveryBatch[] = [];
  const singles: number[] = [];
  for (const animated of [0, 1]) {
    const ids = rows.filter((row) => Number(row.animated) === animated).map((row) => Number(row.id));
    for (const group of chunk(ids, STICKER_PACK_MAX)) {
      if (group.length >= STICKER_PACK_MIN) batches.push({ pack: true, ids: group });
      else singles.push(...group);
    }
  }
  return [...batches, ...chunk(singles, DELIVERY_BATCH_SIZE).map((ids) => ({ pack: false, ids }))];
}

export function parseDeliveryPayload(payload: unknown): DeliveryJobPayload | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;
  const batches = value['batches'];
  const validBatches = Array.isArray(batches) && batches.every((batch) => batch && typeof batch === 'object'
    && typeof (batch as DeliveryBatch).pack === 'boolean'
    && Array.isArray((batch as DeliveryBatch).ids) && (batch as DeliveryBatch).ids.every((id) => Number.isSafeInteger(id)));
  return typeof value['identityId'] === 'string' && value['identityId'] && typeof value['chatId'] === 'string' && value['chatId']
    && typeof value['deliveryId'] === 'string' && value['deliveryId'] && validBatches
    && typeof value['packName'] === 'string' && Number.isSafeInteger(value['packCount']) && Number.isSafeInteger(value['packsSent'])
    ? value as unknown as DeliveryJobPayload
    : undefined;
}

export function newDeliveryId(): string {
  return randomUUID();
}

export interface DeliveryStart {
  scopeId: string;
  identityId: string;
  chatId: string;
  stickerIds: number[];
  asPacks: boolean;
  packName: string;
}

export function startDelivery(db: PluginDatabase, input: DeliveryStart): DeliveryJobPayload & { scopeId: string } {
  const batches = planDeliveryBatches(db, input.scopeId, input.stickerIds, input.asPacks);
  return {
    scopeId: input.scopeId,
    identityId: input.identityId,
    chatId: input.chatId,
    deliveryId: newDeliveryId(),
    batches,
    packName: input.packName,
    packCount: batches.filter((batch) => batch.pack).length,
    packsSent: 0
  };
}

/**
 * Sends the next batch of a delivery and queues the rest. Stickers whose file
 * vanished are dropped from the collection instead of failing the send.
 */
export async function deliverBatch(
  deps: StickerThiefDeps,
  db: PluginDatabase,
  input: DeliveryJobPayload & { scopeId: string }
): Promise<PluginAction[]> {
  const [batch, ...rest] = input.batches;
  if (!batch) return [];
  const files: Array<{ id: number; sha256: string; buffer: Buffer }> = [];
  for (const sticker of stickersByIds(db, input.scopeId, batch.ids)) {
    const stored = await deps.mediaStore?.read(sticker.media_id);
    if (!stored) {
      dropStickerEverywhere(db, sticker.id);
      continue;
    }
    files.push({ id: Number(sticker.id), sha256: sticker.sha256, buffer: stored.buffer });
  }
  const file = (sticker: { sha256: string; buffer: Buffer }) =>
    ({ filename: `${sticker.sha256.slice(0, 16)}.webp`, mimeType: STICKER_MIME_TYPE, buffer: sticker.buffer });
  const actions: PluginAction[] = [];
  let packsSent = input.packsSent;
  if (batch.pack && files.length) {
    packsSent += 1;
    actions.push({
      type: 'message.sendStickerPack',
      chatId: input.chatId,
      pack: {
        id: `${input.deliveryId}-${packsSent}`,
        name: input.packCount > 1 ? `${input.packName} (${packsSent}/${input.packCount})` : input.packName,
        publisher: STICKER_PACK_PUBLISHER,
        stickers: files.map((sticker) => ({ file: file(sticker) }))
      },
      idempotencyKey: `sticker-thief:${input.deliveryId}:pack:${packsSent}`
    });
  } else {
    for (const sticker of files) {
      actions.push({
        type: 'message.sendSticker',
        chatId: input.chatId,
        file: file(sticker),
        idempotencyKey: `sticker-thief:${input.deliveryId}:${sticker.sha256}`
      });
    }
  }
  recordDeliveries(db, input.scopeId, input.identityId, files.map((sticker) => sticker.id), nowFrom(deps));
  if (rest.length) {
    const payload: DeliveryJobPayload = {
      identityId: input.identityId, chatId: input.chatId, deliveryId: input.deliveryId, batches: rest,
      packName: input.packName, packCount: input.packCount, packsSent
    };
    await enqueue(deps, {
      jobName: STICKER_THIEF_DELIVER_JOB,
      executionClass: 'maintenance',
      scopeId: input.scopeId,
      payload,
      runAt: new Date(nowFrom(deps).getTime() + (batch.pack ? STICKER_PACK_SPACING_MS : DELIVERY_BATCH_SPACING_MS)),
      dedupeKey: `sticker-thief:deliver:${input.deliveryId}:${rest.length}`
    });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

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
  const payload: DigestJobPayload = { identityId: subscription.identity_id, dueAt: subscription.next_due_at };
  const due = new Date(subscription.next_due_at);
  const now = nowFrom(deps);
  await enqueue(deps, {
    jobName: STICKER_THIEF_DIGEST_JOB,
    executionClass: 'maintenance',
    scopeId: subscription.scope_id,
    payload,
    runAt: due.getTime() > now.getTime() ? due : now,
    dedupeKey: `sticker-thief:digest:${subscription.scope_id}:${subscription.identity_id}:${due.getTime()}`,
    replaceRetainedTerminalJob: true
  });
}

// ---------------------------------------------------------------------------
// Chat archive backfill: one archive page per job, per covered chat.
// ---------------------------------------------------------------------------

function backfillAllowed(deps: StickerThiefDeps, config: StickerThiefConfig): boolean {
  return Boolean(deps.archivedStickers && config.enabled && config.collect && config.backfillArchive);
}

/**
 * Starts (or, on restart, resumes) the scope's archive backfill. Chats already
 * finished are skipped quickly, so re-running also picks up newly covered chats.
 */
export async function startBackfill(deps: StickerThiefDeps, scopeId: string, options: { onlyFirstTime?: boolean } = {}): Promise<boolean> {
  const db = stickerDatabase(deps);
  if (!db) return false;
  if (options.onlyFirstTime && db.get('SELECT 1 AS hit FROM backfill_scopes WHERE scope_id = ?', scopeId)) return false;
  if (!backfillAllowed(deps, await configFor(deps, scopeId))) return false;
  const first = requestBackfill(db, scopeId, nowFrom(deps));
  if (options.onlyFirstTime && !first) return false;
  await enqueue(deps, {
    jobName: STICKER_THIEF_BACKFILL_JOB,
    executionClass: 'maintenance',
    scopeId,
    payload: {},
    runAt: nowFrom(deps),
    dedupeKey: `sticker-thief:backfill:${scopeId}:start`,
    replaceRetainedTerminalJob: true
  });
  return true;
}

export type BackfillPageResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'page'; chatId: string; listed: number; imported: number; chatDone: boolean }
  | { kind: 'done' };

export async function runBackfillPage(deps: StickerThiefDeps, scopeId: string): Promise<BackfillPageResult> {
  const config = await configFor(deps, scopeId);
  const db = stickerDatabase(deps);
  if (!db || !deps.archivedStickers || !deps.coveredGroupsForScope) return { kind: 'skipped', reason: 'archive-unavailable' };
  if (!backfillAllowed(deps, config)) return { kind: 'skipped', reason: 'backfill-disabled' };
  const chats = [...new Set((await deps.coveredGroupsForScope(scopeId)).map((group) => group.groupWid))].sort();
  for (const chatId of chats) {
    const progress = backfillChat(db, scopeId, chatId, nowFrom(deps));
    if (progress.done) continue;
    const items = await deps.archivedStickers.list({
      scopeId, chatId, limit: BACKFILL_PAGE_SIZE,
      ...(progress.after_media_id ? { afterMediaId: progress.after_media_id } : {})
    });
    let imported = 0;
    for (const item of items) {
      if (item.fromMe || !isWebP(item.mimeType) || (item.sizeBytes ?? 0) > config.maxStickerBytes) continue;
      const stanzaId = stanzaIdOf(item.messageId);
      if (isKnownSighting(db, scopeId, stanzaId)) continue;
      if (item.sha256 && recordKnownSticker(db, { scopeId, stanzaId, sha256: item.sha256, seenAt: item.timestamp })) continue;
      const staged = await deps.archivedStickers.stage({ scopeId, chatId, mediaId: item.mediaId, maxBytes: config.maxStickerBytes });
      if (!staged.ok) continue;
      const outcome = await recordStaged(deps, db, { scopeId, stanzaId, media: staged.media, seenAt: item.timestamp });
      if (outcome.kind === 'new') imported += 1;
    }
    const chatDone = items.length < BACKFILL_PAGE_SIZE;
    const last = items.at(-1)?.mediaId;
    advanceBackfillChat(db, { scopeId, chatId, afterMediaId: last, done: chatDone, imported, now: nowFrom(deps) });
    await enqueue(deps, {
      jobName: STICKER_THIEF_BACKFILL_JOB,
      executionClass: 'maintenance',
      scopeId,
      payload: {},
      runAt: new Date(nowFrom(deps).getTime() + BACKFILL_PAGE_SPACING_MS),
      dedupeKey: `sticker-thief:backfill:${scopeId}:${chatId}:${last ?? 'end'}`
    });
    return { kind: 'page', chatId, listed: items.length, imported, chatDone };
  }
  completeBackfill(db, scopeId, nowFrom(deps));
  return { kind: 'done' };
}
