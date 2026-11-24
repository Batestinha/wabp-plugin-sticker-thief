import { randomUUID } from 'node:crypto';
import type { PluginAction } from '@wabs/plugin-sdk/actions';
import type { PluginArchivedStickers } from '@wabs/plugin-sdk/chat-archive';
import type { PluginAccountStickers } from '@wabs/plugin-sdk/integration-plugin';
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
  BACKFILL_RESCAN_INTERVAL_MS,
  DELIVERY_BATCH_SIZE,
  DELIVERY_BATCH_SPACING_MS,
  STICKER_MIME_TYPE,
  STICKER_PACK_MAX,
  STICKER_PACK_PUBLISHER,
  STICKER_PACK_SPACING_MS,
  STICKER_THIEF_BACKFILL_JOB,
  STICKER_THIEF_DATABASE,
  STICKER_THIEF_PLUGIN_ID,
  STICKER_THIEF_DELIVER_JOB,
  STICKER_THIEF_DIGEST_JOB,
  STICKER_THIEF_FAVORITE_JOB,
  FAVORITE_BATCH_SIZE,
  FAVORITE_BATCH_SPACING_MS,
  FAVORITE_RETRY_BASE_MS,
  FAVORITE_RETRY_MAX_MS
} from './constants';
import {
  advanceBackfillChat,
  backfillChat,
  backfillSummary,
  clearFavoriteFailure,
  completeBackfill,
  favoriteState,
  recordFavoriteFailure,
  dropStickerEverywhere,
  isForgottenSticker,
  isKnownSighting,
  hasDelivery,
  markFavorited,
  pendingFavorites,
  recordDeliveries,
  recordKnownSticker,
  recordSticker,
  stickerCollectedByHash,
  requestBackfill,
  resetBackfillChats,
  selectStickers,
  stickersByIds,
  type RecordStickerResult,
  type SubscriptionRow,
  type BackfillSummary
} from './store';
import { parseWebPInfo } from './webp';

export interface StickerThiefDeps {
  databases?: PluginDatabaseRegistry | undefined;
  mediaStore?: PluginMediaStore | undefined;
  archivedStickers?: PluginArchivedStickers | undefined;
  accountStickers?: PluginAccountStickers | undefined;
  coveredGroupsForScope?: ((scopeId: string) => Promise<PluginCoveredGroup[]>) | undefined;
  currentMemberIdentityIdsForScope?: ((scopeId: string) => Promise<readonly string[]>) | undefined;
  /** One enrolled group. The menu uses this so it does not list every group in the scope. */
  archivedCoveredGroup?: ((scopeId: string, groupWid: string) => Promise<PluginCoveredGroup | undefined>) | undefined;
  /** Recorded membership for one identity. The menu uses this so it does not snapshot WhatsApp. */
  recordedScopeMember?: ((scopeId: string, identityId: string) => Promise<boolean>) | undefined;
  resolveStableIdentityById?: ((identityId: string) => Promise<{ deliveryChatId?: string | null | undefined }>) | undefined;
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
): Promise<CollectOutcome & { buffer?: Buffer }> {
  const stored = isWebP(input.media.mimeType) ? await deps.mediaStore?.read(input.media.id) : undefined;
  const info = stored ? parseWebPInfo(stored.buffer) : undefined;
  if (!stored || !info) {
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
  // The bytes were just read to validate the WebP. The caller can send them
  // without reading the stored file a second time.
  return { ...result, buffer: stored.buffer };
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
// follow-up jobs send one at a time: full native sticker packs (up to 60
// stickers, still and animated together) or, when packs are off, single
// stickers in groups of DELIVERY_BATCH_SIZE.
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

/**
 * Fills each native user-created pack before starting the next one, preserving
 * selection order. This transport supports 1-60 stickers with per-sticker
 * animation metadata; the third-party sticker-app import restrictions do not
 * apply here, so splitting by animation or sending small remainders separately
 * would create unnecessary messages.
 * Since core API 0.3.19 the host resizes and recompresses stickers to WhatsApp's
 * pack rules, so every sticker can go into a pack.
 */
export function planDeliveryBatches(db: PluginDatabase, scopeId: string, stickerIds: number[], asPacks: boolean): DeliveryBatch[] {
  if (!asPacks) return chunk(stickerIds, DELIVERY_BATCH_SIZE).map((ids) => ({ pack: false, ids }));
  const rows = stickersByIds(db, scopeId, stickerIds);
  return chunk(rows.map((row) => Number(row.id)), STICKER_PACK_MAX).map((ids) => ({ pack: true, ids }));
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
      abortBatchOnFailure: true,
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
    // The host executes actions in order. Only schedule another batch after
    // this batch (and its introduction) has actually reached the transport.
    actions.push({
      type: 'plugin.enqueueJob',
      pluginId: STICKER_THIEF_PLUGIN_ID,
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
/** Queues an archive import. A rescan lists every chat again: archive media ids are
 * random, so stickers added since the last pass cannot be found from a cursor. Known
 * stickers are skipped by stanza id and hash, so a rescan reads metadata only. */
export async function startBackfill(deps: StickerThiefDeps, scopeId: string, options: { onlyFirstTime?: boolean; rescan?: boolean } = {}): Promise<boolean> {
  const db = stickerDatabase(deps);
  if (!db) return false;
  if (options.onlyFirstTime && db.get('SELECT 1 AS hit FROM backfill_scopes WHERE scope_id = ?', scopeId)) return false;
  if (!backfillAllowed(deps, await configFor(deps, scopeId))) return false;
  const first = requestBackfill(db, scopeId, nowFrom(deps));
  if (options.onlyFirstTime && !first) return false;
  if (options.rescan) resetBackfillChats(db, scopeId, nowFrom(deps));
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
    if (imported) await scheduleFavorites(deps, scopeId);
    await enqueue(deps, {
      jobName: STICKER_THIEF_BACKFILL_JOB,
      executionClass: 'maintenance',
      scopeId,
      payload: {},
      runAt: new Date(nowFrom(deps).getTime() + BACKFILL_PAGE_SPACING_MS),
      dedupeKey: `sticker-thief:backfill:${scopeId}:${chatId}:${last ?? 'end'}`,
      // A rescan repeats the same page keys; retained finished jobs must not swallow them.
      replaceRetainedTerminalJob: true
    });
    return { kind: 'page', chatId, listed: items.length, imported, chatDone };
  }
  completeBackfill(db, scopeId, nowFrom(deps));
  // The next pass finds stickers that arrived while the bot was not listening.
  await enqueue(deps, {
    jobName: STICKER_THIEF_BACKFILL_JOB,
    executionClass: 'maintenance',
    scopeId,
    payload: { rescan: true },
    runAt: new Date(nowFrom(deps).getTime() + BACKFILL_RESCAN_INTERVAL_MS),
    dedupeKey: `sticker-thief:backfill:${scopeId}:rescan`,
    replaceRetainedTerminalJob: true
  });
  return { kind: 'done' };
}

export function isBackfillRescanJob(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { rescan?: unknown }).rescan === true;
}

export type ArchivedStickerIntent = 'offer' | 'send';
export type ArchivedStickerResult = { result: 'offered' | 'sent' | 'already-sent' | 'refused'; reason?: string };

export interface ArchivedStickerSendInput {
  scopeId: string;
  identityId: string;
  deliveryChatId: string;
  chatId: string;
  groupId: string;
  groupWid: string;
  mediaId: string;
  stanzaId: string;
  sha256: string;
  mimeType: string;
  managementMode: string;
  intent: ArchivedStickerIntent;
}

export interface ArchivedStickerSendHooks {
  executeSend?(file: { buffer: Buffer }): Promise<void>;
}

function canManage(mode: string | undefined): boolean {
  return mode === 'ASSIST' || mode === 'MANAGE';
}

/**
 * The fresh member reader snapshots every WhatsApp group in the scope. An
 * archived sticker offer already knows the one group and the one identity, so
 * it uses the recorded checks when the host provides them.
 */
async function coveredGroupForArchive(
  deps: StickerThiefDeps,
  input: { scopeId: string; groupId: string; groupWid: string }
): Promise<PluginCoveredGroup | undefined> {
  if (deps.archivedCoveredGroup) {
    const group = await deps.archivedCoveredGroup(input.scopeId, input.groupWid);
    if (!group || group.groupId !== input.groupId || group.groupWid !== input.groupWid) return undefined;
    return group;
  }
  if (!deps.coveredGroupsForScope) return undefined;
  const groups = await deps.coveredGroupsForScope(input.scopeId);
  return groups.find((group) => group.groupId === input.groupId && group.groupWid === input.groupWid);
}

async function memberOfScope(deps: StickerThiefDeps, scopeId: string, identityId: string): Promise<boolean | undefined> {
  if (deps.recordedScopeMember) return deps.recordedScopeMember(scopeId, identityId);
  if (!deps.currentMemberIdentityIdsForScope) return undefined;
  return (await deps.currentMemberIdentityIdsForScope(scopeId)).includes(identityId);
}

/**
 * Offers or sends one archived WebP sticker to a member the host has already
 * named. Offer writes nothing. Send stages that one media id only when the
 * file is not already collected, then delivers it to the member's own chat.
 */
async function authorizeArchivedMember(
  deps: StickerThiefDeps,
  input: {
    scopeId: string; identityId: string; deliveryChatId: string; chatId: string;
    groupId: string; groupWid: string; managementMode: string;
  }
): Promise<{ db: PluginDatabase; config: StickerThiefConfig; mediaStore: PluginMediaStore } | ArchivedStickerResult> {
  const db = stickerDatabase(deps);
  if (!db || !deps.mediaStore) return { result: 'refused', reason: 'storage-unavailable' };
  const config = await configFor(deps, input.scopeId);
  if (!config.enabled) return { result: 'refused', reason: 'disabled' };
  if (!canManage(input.managementMode)) return { result: 'refused', reason: 'observe-only' };
  if (!deps.resolveStableIdentityById
    || (!deps.archivedCoveredGroup && !deps.coveredGroupsForScope)
    || (!deps.recordedScopeMember && !deps.currentMemberIdentityIdsForScope)) {
    return { result: 'refused', reason: 'membership-unavailable' };
  }
  const covered = await coveredGroupForArchive(deps, input);
  if (!covered || covered.groupWid !== input.chatId || !canManage(covered.managementMode)) {
    return { result: 'refused', reason: covered ? 'observe-only' : 'not-covered' };
  }
  const member = await memberOfScope(deps, input.scopeId, input.identityId);
  if (member === undefined) return { result: 'refused', reason: 'membership-unavailable' };
  if (!member) return { result: 'refused', reason: 'not-a-member' };
  let resolved: { deliveryChatId?: string | null | undefined };
  try {
    resolved = await deps.resolveStableIdentityById(input.identityId);
  } catch {
    return { result: 'refused', reason: 'delivery-chat-mismatch' };
  }
  if (!resolved.deliveryChatId || resolved.deliveryChatId !== input.deliveryChatId) {
    return { result: 'refused', reason: 'delivery-chat-mismatch' };
  }
  return { db, config, mediaStore: deps.mediaStore };
}

function refused(value: { db: PluginDatabase; config: StickerThiefConfig; mediaStore: PluginMediaStore } | ArchivedStickerResult): value is ArchivedStickerResult {
  return 'result' in value;
}

export async function sendArchivedSticker(
  deps: StickerThiefDeps,
  input: ArchivedStickerSendInput,
  hooks: ArchivedStickerSendHooks = {}
): Promise<ArchivedStickerResult> {
  if (!isWebP(input.mimeType) || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    return { result: 'refused', reason: 'unsupported-sticker-format' };
  }
  const gate = await authorizeArchivedMember(deps, input);
  if (refused(gate)) return gate;
  const { db, config, mediaStore } = gate;
  if (isForgottenSticker(db, input.scopeId, input.sha256)) return { result: 'refused', reason: 'forgotten' };
  const stanzaId = stanzaIdOf(input.stanzaId);
  let prepared: Buffer | undefined;
  let row = stickerCollectedByHash(db, input.scopeId, input.sha256);
  if (!row) {
    if (input.intent === 'offer') return { result: 'offered' };
    if (!deps.archivedStickers) return { result: 'refused', reason: 'archive-unavailable' };
    const staged = await deps.archivedStickers.stage({
      scopeId: input.scopeId, chatId: input.chatId, mediaId: input.mediaId, maxBytes: config.maxStickerBytes
    });
    if (!staged.ok) return { result: 'refused', reason: staged.reason };
    if (staged.media.sha256 !== input.sha256) {
      await mediaStore.delete(staged.media.id);
      return { result: 'refused', reason: 'hash-mismatch' };
    }
    const outcome = await recordStaged(deps, db, {
      scopeId: input.scopeId, stanzaId, media: staged.media, seenAt: nowFrom(deps)
    });
    if (outcome.kind === 'forgotten') return { result: 'refused', reason: 'forgotten' };
    if (outcome.kind === 'skipped') return { result: 'refused', reason: outcome.reason };
    prepared = outcome.buffer;
    row = stickerCollectedByHash(db, input.scopeId, input.sha256);
    if (!row) return { result: 'refused', reason: 'not-recorded' };
  } else if (input.intent === 'send') {
    recordKnownSticker(db, { scopeId: input.scopeId, stanzaId, sha256: input.sha256, seenAt: nowFrom(deps) });
  }
  if (row.animated && !config.includeAnimated) return { result: 'refused', reason: 'animated-excluded' };
  if (input.intent === 'offer') return { result: 'offered' };
  if (hasDelivery(db, input.scopeId, input.identityId, row.id)) return { result: 'already-sent' };
  const stored = prepared ? { buffer: prepared } : await mediaStore.read(row.mediaId);
  if (!stored) return { result: 'refused', reason: 'media-missing' };
  if (!hooks.executeSend) return { result: 'refused', reason: 'send-unavailable' };
  await hooks.executeSend({ buffer: stored.buffer });
  recordDeliveries(db, input.scopeId, input.identityId, [row.id], nowFrom(deps));
  return { result: 'sent' };
}

export interface ArchivedStickerPackSendInput {
  scopeId: string;
  identityId: string;
  deliveryChatId: string;
  chatId: string;
  groupId: string;
  groupWid: string;
  managementMode: string;
  stanzaId: string;
  name: string;
  publisher?: string | undefined;
  stickers: ReadonlyArray<{ mediaId: string; sha256: string; mimeType: string; emoji?: string | undefined }>;
  intent: ArchivedStickerIntent;
}

export interface ArchivedStickerPackSendHooks {
  executeSend?(pack: {
    name: string;
    publisher?: string;
    stickers: Array<{ buffer: Buffer; sha256: string; emoji?: string | undefined }>;
  }): Promise<void>;
}

/**
 * Offers or sends one archived pack to the member the host named. A pack with
 * a forgotten sticker, a missing file, or an excluded animation is refused
 * whole. Offer writes nothing.
 */
export async function sendArchivedStickerPack(
  deps: StickerThiefDeps,
  input: ArchivedStickerPackSendInput,
  hooks: ArchivedStickerPackSendHooks = {}
): Promise<ArchivedStickerResult> {
  const name = input.name.trim();
  if (!name || input.stickers.length < 1 || input.stickers.length > STICKER_PACK_MAX) {
    return { result: 'refused', reason: 'unsupported-sticker-format' };
  }
  if (input.stickers.some((sticker) => !isWebP(sticker.mimeType) || !/^[a-f0-9]{64}$/.test(sticker.sha256))) {
    return { result: 'refused', reason: 'unsupported-sticker-format' };
  }
  const gate = await authorizeArchivedMember(deps, input);
  if (refused(gate)) return gate;
  const { db, config, mediaStore } = gate;
  const stanzaId = stanzaIdOf(input.stanzaId);
  const prepared: Array<{ id: number; mediaId: string; sha256: string; buffer?: Buffer; emoji?: string }> = [];
  for (const sticker of input.stickers) {
    if (isForgottenSticker(db, input.scopeId, sticker.sha256)) return { result: 'refused', reason: 'forgotten' };
    let row = stickerCollectedByHash(db, input.scopeId, sticker.sha256);
    let buffer: Buffer | undefined;
    if (!row) {
      if (input.intent === 'offer') {
        prepared.push({ id: 0, mediaId: sticker.mediaId, sha256: sticker.sha256, ...(sticker.emoji ? { emoji: sticker.emoji } : {}) });
        continue;
      }
      if (!deps.archivedStickers) return { result: 'refused', reason: 'archive-unavailable' };
      const staged = await deps.archivedStickers.stage({
        scopeId: input.scopeId, chatId: input.chatId, mediaId: sticker.mediaId, maxBytes: config.maxStickerBytes
      });
      if (!staged.ok) return { result: 'refused', reason: staged.reason };
      if (staged.media.sha256 !== sticker.sha256) {
        await mediaStore.delete(staged.media.id);
        return { result: 'refused', reason: 'hash-mismatch' };
      }
      const outcome = await recordStaged(deps, db, {
        scopeId: input.scopeId, stanzaId, media: staged.media, seenAt: nowFrom(deps)
      });
      if (outcome.kind === 'forgotten') return { result: 'refused', reason: 'forgotten' };
      if (outcome.kind === 'skipped') return { result: 'refused', reason: outcome.reason };
      buffer = outcome.buffer;
      row = stickerCollectedByHash(db, input.scopeId, sticker.sha256);
      if (!row) return { result: 'refused', reason: 'not-recorded' };
    } else if (input.intent === 'send') {
      recordKnownSticker(db, { scopeId: input.scopeId, stanzaId, sha256: sticker.sha256, seenAt: nowFrom(deps) });
    }
    if (row.animated && !config.includeAnimated) return { result: 'refused', reason: 'animated-excluded' };
    prepared.push({
      id: row.id, mediaId: row.mediaId, sha256: sticker.sha256,
      ...(buffer ? { buffer } : {}), ...(sticker.emoji ? { emoji: sticker.emoji } : {})
    });
  }
  if (input.intent === 'offer') return { result: 'offered' };
  if (prepared.every((sticker) => sticker.id && hasDelivery(db, input.scopeId, input.identityId, sticker.id))) {
    return { result: 'already-sent' };
  }
  const stickers: Array<{ buffer: Buffer; sha256: string; emoji?: string | undefined }> = [];
  for (const sticker of prepared) {
    const stored = sticker.buffer ? { buffer: sticker.buffer } : await mediaStore.read(sticker.mediaId);
    if (!stored) return { result: 'refused', reason: 'media-missing' };
    stickers.push({ buffer: stored.buffer, sha256: sticker.sha256, ...(sticker.emoji ? { emoji: sticker.emoji } : {}) });
  }
  if (!hooks.executeSend) return { result: 'refused', reason: 'send-unavailable' };
  await hooks.executeSend({
    name, ...(input.publisher?.trim() ? { publisher: input.publisher.trim() } : {}), stickers
  });
  recordDeliveries(db, input.scopeId, input.identityId, prepared.map((sticker) => sticker.id), nowFrom(deps));
  return { result: 'sent' };
}

/** Operator request: list the archive again now and report where things stand. */
export async function reimportArchive(deps: StickerThiefDeps, scopeId: string): Promise<{ queued: boolean; reason?: string } & Partial<BackfillSummary>> {
  const db = stickerDatabase(deps);
  if (!db) return { queued: false, reason: 'storage-unavailable' };
  if (!backfillAllowed(deps, await configFor(deps, scopeId))) return { queued: false, reason: 'backfill-disabled', ...backfillSummary(db, scopeId) };
  const queued = await startBackfill(deps, scopeId, { rescan: true });
  return { queued, ...backfillSummary(db, scopeId) };
}

// ---------------------------------------------------------------------------
// Bot account favourites: WhatsApp syncs favourite stickers (not packs) to an
// account's devices, so every collected sticker is favourited on the bot.
// ---------------------------------------------------------------------------

function favoritesAllowed(deps: StickerThiefDeps, config: StickerThiefConfig): boolean {
  return Boolean(deps.accountStickers && config.enabled && config.favoriteOnBotAccount);
}

/**
 * Queues a favourite run for the scope; a pending run absorbs repeated calls, and a
 * scope that is backing off after a transport failure keeps its scheduled retry.
 */
export async function scheduleFavorites(deps: StickerThiefDeps, scopeId: string, delayMs = 5_000): Promise<boolean> {
  if (!favoritesAllowed(deps, await configFor(deps, scopeId))) return false;
  const db = stickerDatabase(deps);
  const retryAt = db ? favoriteState(db, scopeId)?.next_retry_at : undefined;
  if (retryAt && Date.parse(retryAt) > nowFrom(deps).getTime()) return false;
  await enqueue(deps, {
    jobName: STICKER_THIEF_FAVORITE_JOB,
    executionClass: 'maintenance',
    scopeId,
    payload: {},
    runAt: new Date(nowFrom(deps).getTime() + delayMs),
    dedupeKey: `sticker-thief:favorite:${scopeId}`,
    replaceRetainedTerminalJob: true
  });
  return true;
}

export type FavoriteRunResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'favorited'; count: number; more: boolean }
  /** The transport refused (for example WhatsApp is waiting for the phone); a retry is queued. */
  | { kind: 'deferred'; error: string; attempts: number; retryAt: Date };

/** Doubling delays from five minutes up to an hour. */
export function favoriteRetryDelayMs(attempts: number): number {
  return Math.min(FAVORITE_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 8)), FAVORITE_RETRY_MAX_MS);
}

/** Favourites the next batch of the scope's stickers on the bot account. */
export async function runFavorites(deps: StickerThiefDeps, scopeId: string): Promise<FavoriteRunResult> {
  const db = stickerDatabase(deps);
  if (!db || !deps.mediaStore) return { kind: 'skipped', reason: 'storage-unavailable' };
  if (!favoritesAllowed(deps, await configFor(deps, scopeId))) return { kind: 'skipped', reason: 'favorites-disabled' };
  const pending = pendingFavorites(db, scopeId, FAVORITE_BATCH_SIZE + 1);
  const batch = pending.slice(0, FAVORITE_BATCH_SIZE);
  if (!batch.length) return { kind: 'favorited', count: 0, more: false };
  const files: Array<{ filename: string; mimeType: string; buffer: Buffer }> = [];
  const ids: number[] = [];
  for (const sticker of batch) {
    const stored = await deps.mediaStore.read(sticker.media_id);
    if (!stored) {
      dropStickerEverywhere(db, sticker.id);
      continue;
    }
    files.push({ filename: `${sticker.id}.webp`, mimeType: STICKER_MIME_TYPE, buffer: stored.buffer });
    ids.push(Number(sticker.id));
  }
  if (files.length) {
    try {
      await deps.accountStickers!.setFavorite({ scopeId, files, favorite: true });
    } catch (error) {
      const now = nowFrom(deps);
      const attempts = (favoriteState(db, scopeId)?.attempts ?? 0) + 1;
      const retryAt = new Date(now.getTime() + favoriteRetryDelayMs(attempts));
      const message = error instanceof Error ? error.message : String(error);
      recordFavoriteFailure(db, { scopeId, error: message, now, retryAt });
      await enqueue(deps, {
        jobName: STICKER_THIEF_FAVORITE_JOB,
        executionClass: 'maintenance',
        scopeId,
        payload: { retry: attempts },
        runAt: retryAt,
        dedupeKey: `sticker-thief:favorite:${scopeId}:retry:${attempts}`,
        replaceRetainedTerminalJob: true
      });
      return { kind: 'deferred', error: message, attempts, retryAt };
    }
    markFavorited(db, ids, nowFrom(deps));
    clearFavoriteFailure(db, scopeId);
  }
  const more = pending.length > FAVORITE_BATCH_SIZE;
  if (more) {
    await enqueue(deps, {
      jobName: STICKER_THIEF_FAVORITE_JOB,
      executionClass: 'maintenance',
      scopeId,
      payload: {},
      runAt: new Date(nowFrom(deps).getTime() + FAVORITE_BATCH_SPACING_MS),
      dedupeKey: `sticker-thief:favorite:${scopeId}:${ids.at(-1) ?? 0}`
    });
  }
  return { kind: 'favorited', count: files.length, more };
}
