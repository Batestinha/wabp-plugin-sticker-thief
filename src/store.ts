import type { PluginDatabase } from '@wabs/plugin-sdk/database';
import { CADENCE_INTERVAL_MS, type Cadence } from './constants';

export interface StickerRow {
  id: number;
  sha256: string;
  media_id: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  animated: number;
}

export interface SubscriptionRow {
  scope_id: string;
  identity_id: string;
  cadence: Cadence;
  next_due_at: string;
  created_at: string;
}

export interface NewSticker {
  scopeId: string;
  stanzaId: string;
  sha256: string;
  mediaId: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | undefined;
  height?: number | undefined;
  animated: boolean;
  seenAt: Date;
}

export type RecordStickerResult =
  | { kind: 'new'; stickerId: number }
  | { kind: 'known'; stickerId: number; duplicateMediaId: string }
  | { kind: 'forgotten'; duplicateMediaId: string };

/**
 * Records a collected sticker. Content-addressed: a sticker already known (in
 * any scope) keeps its original media and the caller deletes the new copy.
 */
export function recordSticker(db: PluginDatabase, input: NewSticker): RecordStickerResult {
  return db.transaction(() => {
    const seenAt = input.seenAt.toISOString();
    if (db.get('SELECT 1 AS hit FROM forgotten_stickers WHERE scope_id = ? AND sha256 = ?', input.scopeId, input.sha256)) {
      return { kind: 'forgotten', duplicateMediaId: input.mediaId } as const;
    }
    const inserted = db.run(
      `INSERT OR IGNORE INTO stickers (sha256, media_id, mime_type, size_bytes, width, height, animated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.sha256, input.mediaId, input.mimeType, input.sizeBytes,
      input.width ?? null, input.height ?? null, input.animated ? 1 : 0, seenAt
    );
    const sticker = db.get<{ id: number; media_id: string }>('SELECT id, media_id FROM stickers WHERE sha256 = ?', input.sha256);
    if (!sticker) throw new Error('Sticker row disappeared during insert.');
    db.run(
      `INSERT INTO sticker_scopes (scope_id, sticker_id, first_seen_at, last_seen_at, seen_count) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (scope_id, sticker_id) DO UPDATE SET
         first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
         last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
         seen_count = seen_count + 1`,
      input.scopeId, sticker.id, seenAt, seenAt
    );
    db.run(
      'INSERT OR IGNORE INTO sticker_sightings (scope_id, stanza_id, sticker_id, seen_at) VALUES (?, ?, ?, ?)',
      input.scopeId, input.stanzaId, sticker.id, seenAt
    );
    return inserted.changes > 0
      ? { kind: 'new', stickerId: Number(sticker.id) } as const
      : { kind: 'known', stickerId: Number(sticker.id), duplicateMediaId: input.mediaId } as const;
  });
}

export function isKnownSighting(db: PluginDatabase, scopeId: string, stanzaId: string): boolean {
  return Boolean(db.get('SELECT 1 AS hit FROM sticker_sightings WHERE scope_id = ? AND stanza_id = ?', scopeId, stanzaId));
}

export interface SelectStickersInput {
  scopeId: string;
  identityId: string;
  limit: number;
  includeAnimated: boolean;
  order: 'oldest-unseen' | 'random';
}

export function selectStickers(db: PluginDatabase, input: SelectStickersInput): StickerRow[] {
  const unseenOnly = input.order === 'oldest-unseen';
  return db.all<StickerRow & Record<string, unknown>>(
    `SELECT s.id, s.sha256, s.media_id, s.mime_type, s.size_bytes, s.width, s.height, s.animated
       FROM sticker_scopes ss JOIN stickers s ON s.id = ss.sticker_id
      WHERE ss.scope_id = ?
        AND (? = 1 OR s.animated = 0)
        AND (? = 0 OR NOT EXISTS (
          SELECT 1 FROM deliveries d WHERE d.scope_id = ss.scope_id AND d.identity_id = ? AND d.sticker_id = s.id))
      ORDER BY ${unseenOnly ? 'ss.first_seen_at, s.id' : 'random()'}
      LIMIT ?`,
    input.scopeId, input.includeAnimated ? 1 : 0, unseenOnly ? 1 : 0, input.identityId, input.limit > 0 ? input.limit : -1
  );
}

/** Loads stickers still collected in the scope, in the order of the given ids. */
export function stickersByIds(db: PluginDatabase, scopeId: string, ids: number[]): StickerRow[] {
  const rows = new Map<number, StickerRow>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    for (const row of db.all<StickerRow & Record<string, unknown>>(
      `SELECT s.id, s.sha256, s.media_id, s.mime_type, s.size_bytes, s.width, s.height, s.animated
         FROM stickers s JOIN sticker_scopes ss ON ss.sticker_id = s.id AND ss.scope_id = ?
        WHERE s.id IN (${chunk.map(() => '?').join(',')})`,
      scopeId, ...chunk
    )) rows.set(Number(row.id), row);
  }
  return ids.flatMap((id) => rows.get(id) ?? []);
}

/**
 * Records a sighting of a sticker whose content hash is already collected,
 * without touching media. Returns false when the hash is unknown or forgotten here.
 */
export function recordKnownSticker(db: PluginDatabase, input: { scopeId: string; stanzaId: string; sha256: string; seenAt: Date }): boolean {
  return db.transaction(() => {
    if (db.get('SELECT 1 AS hit FROM forgotten_stickers WHERE scope_id = ? AND sha256 = ?', input.scopeId, input.sha256)) return true;
    const sticker = db.get<{ id: number }>('SELECT id FROM stickers WHERE sha256 = ?', input.sha256);
    if (!sticker) return false;
    const seenAt = input.seenAt.toISOString();
    db.run(
      `INSERT INTO sticker_scopes (scope_id, sticker_id, first_seen_at, last_seen_at, seen_count) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (scope_id, sticker_id) DO UPDATE SET
         first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
         last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
         seen_count = seen_count + 1`,
      input.scopeId, sticker.id, seenAt, seenAt
    );
    db.run('INSERT OR IGNORE INTO sticker_sightings (scope_id, stanza_id, sticker_id, seen_at) VALUES (?, ?, ?, ?)',
      input.scopeId, input.stanzaId, sticker.id, seenAt);
    return true;
  });
}

export interface BackfillChatRow {
  scope_id: string;
  chat_id: string;
  after_media_id: string | null;
  done: number;
  imported: number;
}

/** Marks a scope as requested; returns true only the first time. */
export function requestBackfill(db: PluginDatabase, scopeId: string, now: Date): boolean {
  return db.run('INSERT OR IGNORE INTO backfill_scopes (scope_id, requested_at) VALUES (?, ?)', scopeId, now.toISOString()).changes > 0;
}

export function backfillChat(db: PluginDatabase, scopeId: string, chatId: string, now: Date): BackfillChatRow {
  db.run('INSERT OR IGNORE INTO backfill_chats (scope_id, chat_id, updated_at) VALUES (?, ?, ?)', scopeId, chatId, now.toISOString());
  return db.get<BackfillChatRow & Record<string, unknown>>(
    'SELECT scope_id, chat_id, after_media_id, done, imported FROM backfill_chats WHERE scope_id = ? AND chat_id = ?', scopeId, chatId
  )!;
}

export function advanceBackfillChat(
  db: PluginDatabase,
  input: { scopeId: string; chatId: string; afterMediaId: string | undefined; done: boolean; imported: number; now: Date }
): void {
  db.run(
    `UPDATE backfill_chats SET after_media_id = COALESCE(?, after_media_id), done = ?, imported = imported + ?, updated_at = ?
      WHERE scope_id = ? AND chat_id = ?`,
    input.afterMediaId ?? null, input.done ? 1 : 0, input.imported, input.now.toISOString(), input.scopeId, input.chatId
  );
}

export function completeBackfill(db: PluginDatabase, scopeId: string, now: Date): void {
  db.run('UPDATE backfill_scopes SET completed_at = ? WHERE scope_id = ?', now.toISOString(), scopeId);
}

export function backfillImported(db: PluginDatabase, scopeId: string): number {
  return Number(db.get<{ n: number }>('SELECT COALESCE(SUM(imported), 0) AS n FROM backfill_chats WHERE scope_id = ?', scopeId)?.n ?? 0);
}

export function recordDeliveries(db: PluginDatabase, scopeId: string, identityId: string, stickerIds: number[], at: Date): void {
  db.transaction(() => {
    for (const stickerId of stickerIds) {
      db.run(
        'INSERT OR IGNORE INTO deliveries (scope_id, identity_id, sticker_id, delivered_at) VALUES (?, ?, ?, ?)',
        scopeId, identityId, stickerId, at.toISOString()
      );
    }
  });
}

export interface ScopeStats {
  total: number;
  unseen: number;
}

export function scopeStats(db: PluginDatabase, scopeId: string, identityId: string, includeAnimated: boolean): ScopeStats {
  const row = db.get<{ total: number; seen: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM deliveries d WHERE d.scope_id = ss.scope_id AND d.identity_id = ? AND d.sticker_id = s.id)
                THEN 1 ELSE 0 END) AS seen
       FROM sticker_scopes ss JOIN stickers s ON s.id = ss.sticker_id
      WHERE ss.scope_id = ? AND (? = 1 OR s.animated = 0)`,
    identityId, scopeId, includeAnimated ? 1 : 0
  );
  const total = Number(row?.total ?? 0);
  return { total, unseen: total - Number(row?.seen ?? 0) };
}

export function getSubscription(db: PluginDatabase, scopeId: string, identityId: string): SubscriptionRow | undefined {
  return db.get<SubscriptionRow & Record<string, unknown>>(
    'SELECT scope_id, identity_id, cadence, next_due_at, created_at FROM subscriptions WHERE scope_id = ? AND identity_id = ?',
    scopeId, identityId
  );
}

export function listSubscriptions(db: PluginDatabase): SubscriptionRow[] {
  return db.all<SubscriptionRow & Record<string, unknown>>(
    'SELECT scope_id, identity_id, cadence, next_due_at, created_at FROM subscriptions ORDER BY scope_id, identity_id'
  );
}

export function upsertSubscription(db: PluginDatabase, scopeId: string, identityId: string, cadence: Cadence, now: Date): SubscriptionRow {
  const nextDueAt = new Date(now.getTime() + CADENCE_INTERVAL_MS[cadence]).toISOString();
  db.run(
    `INSERT INTO subscriptions (scope_id, identity_id, cadence, next_due_at, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (scope_id, identity_id) DO UPDATE SET cadence = excluded.cadence, next_due_at = excluded.next_due_at`,
    scopeId, identityId, cadence, nextDueAt, now.toISOString()
  );
  const row = getSubscription(db, scopeId, identityId);
  if (!row) throw new Error('Subscription row disappeared during upsert.');
  return row;
}

export function deleteSubscription(db: PluginDatabase, scopeId: string, identityId: string): boolean {
  return db.run('DELETE FROM subscriptions WHERE scope_id = ? AND identity_id = ?', scopeId, identityId).changes > 0;
}

/** Advances by whole intervals so digests keep their time of day, skipping any missed while the bot was down. */
export function nextDueAfter(previousDueAt: Date, cadence: Cadence, now: Date): Date {
  const interval = CADENCE_INTERVAL_MS[cadence];
  let next = previousDueAt.getTime() + interval;
  if (next <= now.getTime()) {
    next += Math.ceil((now.getTime() - next + 1) / interval) * interval;
  }
  return new Date(next);
}

export function advanceSubscription(db: PluginDatabase, scopeId: string, identityId: string, nextDueAt: Date): void {
  db.run('UPDATE subscriptions SET next_due_at = ? WHERE scope_id = ? AND identity_id = ?', nextDueAt.toISOString(), scopeId, identityId);
}

export type ForgetResult =
  | { kind: 'not-found' }
  | { kind: 'forgotten'; sha256: string; orphanMediaId?: string | undefined };

/** Removes a sticker from one scope and blocks it there. Returns the media id when no scope references it any more. */
export function forgetStickerBySighting(db: PluginDatabase, scopeId: string, stanzaId: string, actorIdentityId: string, now: Date): ForgetResult {
  return db.transaction(() => {
    const sticker = db.get<{ id: number; sha256: string; media_id: string }>(
      `SELECT s.id, s.sha256, s.media_id FROM sticker_sightings ss JOIN stickers s ON s.id = ss.sticker_id
        WHERE ss.scope_id = ? AND ss.stanza_id = ?`,
      scopeId, stanzaId
    );
    if (!sticker) return { kind: 'not-found' } as const;
    db.run(
      'INSERT OR IGNORE INTO forgotten_stickers (scope_id, sha256, forgotten_at, actor_identity_id) VALUES (?, ?, ?, ?)',
      scopeId, sticker.sha256, now.toISOString(), actorIdentityId
    );
    db.run('DELETE FROM sticker_scopes WHERE scope_id = ? AND sticker_id = ?', scopeId, sticker.id);
    db.run('DELETE FROM sticker_sightings WHERE scope_id = ? AND sticker_id = ?', scopeId, sticker.id);
    db.run('DELETE FROM deliveries WHERE scope_id = ? AND sticker_id = ?', scopeId, sticker.id);
    const stillUsed = db.get('SELECT 1 AS hit FROM sticker_scopes WHERE sticker_id = ?', sticker.id);
    if (stillUsed) return { kind: 'forgotten', sha256: sticker.sha256 } as const;
    db.run('DELETE FROM stickers WHERE id = ?', sticker.id);
    return { kind: 'forgotten', sha256: sticker.sha256, orphanMediaId: sticker.media_id } as const;
  });
}

/** Drops a sticker whose media file has gone missing so it is not selected again. */
export function dropStickerEverywhere(db: PluginDatabase, stickerId: number): void {
  db.transaction(() => {
    for (const table of ['sticker_scopes', 'sticker_sightings', 'deliveries']) {
      db.run(`DELETE FROM ${table} WHERE sticker_id = ?`, stickerId);
    }
    db.run('DELETE FROM stickers WHERE id = ?', stickerId);
  });
}
