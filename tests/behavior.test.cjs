const { test } = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../dist/index.js').default;
const { collectSticker } = require('../dist/service.js');
const { runDigest } = require('../dist/hooks.js');
const { nextDueAfter } = require('../dist/store.js');
const { parseWebPInfo } = require('../dist/webp.js');
const { harness, webp } = require('./helpers.cjs');

const SCOPE = 'scope-1';

function setup(options) {
  const h = harness(options);
  plugin.registerCommands(h.context);
  const hooks = plugin.registerHooks(h.context);
  return { ...h, hooks };
}

test('collects each distinct sticker once and discards duplicate copies', async () => {
  const h = setup();
  const first = h.addSticker(webp({ salt: 'a' }));
  const again = h.addSticker(webp({ salt: 'a' }));
  const other = h.addSticker(webp({ salt: 'b' }));
  assert.equal((await collectSticker(h.context, SCOPE, first)).kind, 'new');
  assert.equal((await collectSticker(h.context, SCOPE, again)).kind, 'known');
  assert.equal((await collectSticker(h.context, SCOPE, other)).kind, 'new');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers').n, 2);
  assert.equal(h.db.get('SELECT seen_count FROM sticker_scopes ORDER BY sticker_id LIMIT 1').seen_count, 2);
  assert.equal(h.media.stored.size, 2, 'duplicate staged media is deleted');
  // Redelivered events for the same message are ignored without downloading.
  assert.deepEqual(await collectSticker(h.context, SCOPE, first), { kind: 'skipped', reason: 'already-recorded' });
});

test('skips own, private, disabled, oversized and non-WebP stickers', async () => {
  const h = setup({ config: { maxStickerBytes: 1024 } });
  const reasons = [];
  for (const message of [
    h.addSticker(webp(), { fromMe: true }),
    h.addSticker(webp(), { context: 'private' }),
    h.addSticker(webp(), { type: 'image' }),
    h.addSticker(webp(), { media: { mimeType: 'application/was' } }),
    h.addSticker(webp(), { media: { mimeType: 'image/webp', sizeBytes: 5000 } })
  ]) reasons.push((await collectSticker(h.context, SCOPE, message)).reason);
  assert.deepEqual(reasons, ['not-a-live-group-sticker', 'not-a-live-group-sticker', 'not-a-live-group-sticker', 'unsupported-sticker-format', 'too-large']);
  const disguised = h.addSticker(Buffer.from('not really webp but long enough to pass length'));
  assert.equal((await collectSticker(h.context, SCOPE, disguised)).reason, 'unsupported-sticker-format');
  assert.equal(h.media.stored.size, 0, 'rejected downloads are deleted');
  const off = setup({ config: { enabled: false } });
  assert.equal((await collectSticker(off.context, SCOPE, off.addSticker(webp()))).reason, 'collection-disabled');
});

test('manual send delivers unseen stickers privately as native stickers, once each', async () => {
  const h = setup({ config: { deliverAsPacks: false } });
  for (const salt of ['a', 'b', 'c']) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt })));
  const first = await h.command('send', { args: ['2'] });
  assert.equal(first.pluginActions.length, 2);
  for (const action of first.pluginActions) {
    assert.equal(action.type, 'message.sendSticker');
    assert.equal(action.chatId, 'alice@lid');
    assert.equal(action.file.mimeType, 'image/webp');
    assert.ok(Buffer.isBuffer(action.file.buffer));
    assert.match(action.idempotencyKey, /^sticker-thief:[0-9a-f-]{36}:[0-9a-f]{64}$/);
  }
  assert.equal((await h.command('send')).pluginActions.length, 1);
  const none = await h.command('send');
  assert.equal(none.pluginActions, undefined);
  assert.match(none.text, /noNewStickers.*"total":3/);
  // Another member still gets everything.
  assert.equal((await h.command('send', { identityId: 'bob' })).pluginActions.length, 3);
  // Random ignores what was already seen.
  assert.equal((await h.command('random', { args: ['5'] })).pluginActions.length, 3);
});

test('uses the configured limit only without a number, hides animated stickers when configured and refuses OBSERVE scopes', async () => {
  const h = setup({ config: { manualSendLimit: 1, includeAnimated: false } });
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'still-1' })));
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'still-2' })));
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'moving', animated: true })));
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers WHERE animated = 1').n, 1);
  assert.match((await h.command('send', { managementMode: 'OBSERVE' })).text, /observeOnly/);
  assert.equal((await h.command('send')).pluginActions.length, 1, 'configured limit');
  assert.equal((await h.command('send', { args: ['10'] })).pluginActions.length, 1, 'only one still unseen');
  assert.match((await h.command('send')).text, /noNewStickers/);
});

test('subscribing schedules a digest that sends a header plus new stickers and reschedules itself', async () => {
  const h = setup({ members: ['alice'], config: { digestSize: 2 } });
  for (const salt of ['a', 'b', 'c']) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt })));
  assert.match((await h.command('subscribe', { args: ['weekly'] })).text, /subscribed.*"available":3/);
  assert.equal(h.jobs.length, 1);
  const [job] = h.jobs;
  assert.equal(job.jobName, 'sticker-thief.digest');
  assert.equal(job.runAt.toISOString(), '2026-11-08T12:00:00.000Z');
  assert.equal(job.dedupeKey, `sticker-thief:digest:${SCOPE}:alice:${Date.parse('2026-11-08T12:00:00.000Z')}`);

  h.setNow('2026-11-08T12:00:05.000Z');
  const actions = await runDigest(h.context, { ...job, scopeId: SCOPE, managementMode: 'ASSIST' });
  assert.deepEqual(actions.map(action => action.type), ['message.sendText', 'message.sendSticker', 'message.sendSticker']);
  assert.match(actions[0].text, /digestHeader.*"count":2/);
  assert.equal(h.jobs.length, 2);
  assert.equal(h.jobs[1].runAt.toISOString(), '2026-11-15T12:00:00.000Z');

  // Re-running the stale job (already advanced) does nothing.
  assert.equal(await runDigest(h.context, { ...job, scopeId: SCOPE, managementMode: 'ASSIST' }), undefined);
  // The next digest sends only the remaining sticker.
  h.setNow('2026-11-15T12:00:00.000Z');
  const second = await runDigest(h.context, { ...h.jobs[1], scopeId: SCOPE, managementMode: 'ASSIST' });
  assert.equal(second.filter(action => action.type === 'message.sendSticker').length, 1);
});

test('digests stop for members who left and are skipped (but kept) in OBSERVE scopes', async () => {
  const h = setup({ members: [] });
  await collectSticker(h.context, SCOPE, h.addSticker(webp()));
  await h.command('subscribe');
  h.setNow('2026-11-02T12:00:00.000Z');
  const ended = await runDigest(h.context, { ...h.jobs[0], scopeId: SCOPE });
  assert.equal(ended[0].action, 'sticker-thief.subscription.ended');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM subscriptions').n, 0);

  const observe = setup({ members: ['alice'] });
  await collectSticker(observe.context, SCOPE, observe.addSticker(webp()));
  await observe.command('subscribe', { args: ['daily'] });
  observe.setNow('2026-11-02T12:00:00.000Z');
  assert.equal(await runDigest(observe.context, { ...observe.jobs[0], scopeId: SCOPE, managementMode: 'OBSERVE' }), undefined);
  assert.equal(observe.jobs.length, 2, 'still rescheduled');
  assert.equal(observe.db.get('SELECT COUNT(*) AS n FROM deliveries').n, 0, 'nothing marked delivered');
});

test('unsubscribe, status and runtime re-seeding', async () => {
  const h = setup();
  await collectSticker(h.context, SCOPE, h.addSticker(webp()));
  assert.match((await h.command('status')).text, /status.*"total":1.*"unseen":1.*status.notSubscribed/);
  await h.command('subscribe', { args: ['daily'] });
  assert.match((await h.command('status')).text, /status.subscribed.*2026-11-02 12:00 UTC/);
  await h.hooks.onRuntimeReady({});
  const digests = h.jobs.filter(j => j.jobName === 'sticker-thief.digest');
  assert.equal(digests.length, 2);
  assert.equal(digests[1].dedupeKey, digests[0].dedupeKey, 're-seeding reuses the pending slot key');
  assert.equal(digests[1].replaceRetainedTerminalJob, true);
  assert.match((await h.command('unsubscribe')).text, /unsubscribed/);
  assert.match((await h.command('unsubscribe')).text, /notSubscribed/);
  assert.equal(await runDigest(h.context, { ...digests[0], scopeId: SCOPE }), undefined);
  assert.match((await h.command('subscribe', { args: ['hourly'] })).text, /subscribeUsage/);
});

test('forget removes a quoted sticker from the scope, deletes orphaned media and blocks recollection', async () => {
  const h = setup();
  const message = h.addSticker(webp({ salt: 'bad' }));
  await collectSticker(h.context, SCOPE, message);
  await collectSticker(h.context, 'scope-2', h.addSticker(webp({ salt: 'bad' })));
  assert.match((await h.command('forget')).text, /forgetUsage/);
  assert.match((await h.command('forget', { replyTo: 'false_group@g.us_UNKNOWN_x@lid' })).text, /forgetNotFound/);

  // Quote ids arrive in a different serialized form; the stanza id still matches.
  const quoted = message.id.replace('false_group@g.us_', 'true_group@g.us_');
  const result = await h.command('forget', { replyTo: quoted });
  assert.match(result.text, /forgotten/);
  assert.equal(result.pluginActions[0].action, 'sticker-thief.forget');
  assert.equal(h.media.stored.size, 1, 'still referenced by scope-2');
  assert.equal((await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'bad' })))).kind, 'forgotten');
  assert.equal(h.media.stored.size, 1);

  const stillThere = await h.command('send', { scopeId: 'scope-2' });
  assert.equal(stillThere.pluginActions.length, 1);
  const message2 = h.db.get("SELECT stanza_id FROM sticker_sightings WHERE scope_id = 'scope-2'").stanza_id;
  await h.command('forget', { scopeId: 'scope-2', replyTo: `false_group@g.us_${message2}_x@lid` });
  assert.equal(h.media.stored.size, 0, 'orphaned media deleted');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers').n, 0);
});

test('stickers whose media vanished are dropped instead of failing the send', async () => {
  const h = setup();
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'a' })));
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'b' })));
  h.media.stored.delete([...h.media.stored.keys()][0]);
  assert.equal((await h.command('send')).pluginActions.length, 1);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers').n, 1);
});

test('nextDueAfter keeps the time of day and skips missed slots', () => {
  const due = new Date('2026-11-01T09:00:00.000Z');
  assert.equal(nextDueAfter(due, 'daily', new Date('2026-11-01T09:00:01Z')).toISOString(), '2026-11-02T09:00:00.000Z');
  assert.equal(nextDueAfter(due, 'daily', new Date('2026-11-05T10:00:00Z')).toISOString(), '2026-11-06T09:00:00.000Z');
  assert.equal(nextDueAfter(due, 'weekly', new Date('2026-11-01T09:00:00Z')).toISOString(), '2026-11-08T09:00:00.000Z');
});

test('parses WebP headers for all three bitstream forms', () => {
  assert.deepEqual(parseWebPInfo(webp({ width: 320, height: 200, animated: true })), { width: 320, height: 200, animated: true });
  const lossy = Buffer.alloc(40);
  lossy.write('RIFF', 0); lossy.write('WEBPVP8 ', 8);
  Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a]).copy(lossy, 20);
  lossy.writeUInt16LE(512, 26); lossy.writeUInt16LE(384, 28);
  assert.deepEqual(parseWebPInfo(lossy), { width: 512, height: 384, animated: false });
  const lossless = Buffer.alloc(40);
  lossless.write('RIFF', 0); lossless.write('WEBPVP8L', 8);
  lossless[20] = 0x2f; lossless.writeUInt32LE(511 | (255 << 14), 21);
  assert.deepEqual(parseWebPInfo(lossless), { width: 512, height: 256, animated: false });
  assert.equal(parseWebPInfo(Buffer.from('GIF89a')), undefined);
});

// --- 0.2.0: no cap, batched delivery ---------------------------------------
const { runDeliveryBatch } = require('../dist/hooks.js');
const { runBackfillPage, startBackfill } = require('../dist/service.js');

async function drainDeliveries(h, scopeId = SCOPE, managementMode = 'ASSIST') {
  const batches = [];
  for (let job; (job = h.jobs.find(j => j.jobName === 'sticker-thief.deliver' && !j.done));) {
    job.done = true;
    batches.push(await runDeliveryBatch(h.context, { ...job, scopeId, managementMode }));
  }
  return batches;
}

test('sends every unseen sticker without a cap, 10 per batch through follow-up jobs', async () => {
  const h = setup({ config: { deliverAsPacks: false } });
  for (let i = 0; i < 25; i++) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: `s${i}` })));
  const first = await h.command('send');
  assert.equal(first.pluginActions.length, 10);
  assert.match(first.text, /sendingBatched.*"count":25/);
  const [job] = h.jobs.filter(j => j.jobName === 'sticker-thief.deliver');
  assert.equal(job.payload.batches.flatMap(b => b.ids).length, 15);
  assert.equal(job.runAt.getTime() - Date.parse('2026-11-01T12:00:00.000Z'), 30_000);
  const batches = await drainDeliveries(h);
  assert.deepEqual(batches.map(b => b.length), [10, 5]);
  const keys = new Set([first, ...batches.map(b => ({ pluginActions: b }))].flatMap(r => r.pluginActions.map(a => a.idempotencyKey)));
  assert.equal(keys.size, 25);
  assert.equal(new Set([...keys].map(k => k.split(':')[1])).size, 1, 'one delivery id per request');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM deliveries').n, 25);
  assert.match((await h.command('send')).text, /noNewStickers/);
});

test('repeat random requests use fresh idempotency keys so WhatsApp does not drop them', async () => {
  const h = setup();
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'only' })));
  const a = (await h.command('random')).pluginActions[0].idempotencyKey;
  const b = (await h.command('random')).pluginActions[0].idempotencyKey;
  assert.notEqual(a, b);
});

test('digests send everything unseen in batches and stop follow-ups in OBSERVE scopes', async () => {
  const h = setup({ members: ['alice'], config: { deliverAsPacks: false } });
  for (let i = 0; i < 12; i++) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: `d${i}` })));
  await h.command('subscribe', { args: ['daily'] });
  h.setNow('2026-11-02T12:00:00.000Z');
  const actions = await runDigest(h.context, { ...h.jobs[0], scopeId: SCOPE, managementMode: 'ASSIST' });
  assert.match(actions[0].text, /digestHeader.*"count":12/);
  assert.equal(actions.filter(a => a.type === 'message.sendSticker').length, 10);
  assert.equal(await drainDeliveries(h, SCOPE, 'OBSERVE').then(b => b[0]), undefined);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM deliveries').n, 10);
});

// --- 0.2.0: chat archive backfill ------------------------------------------

function archivedItems(prefix, count, { start = Date.parse('2026-08-01T00:00:00Z') } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    mediaId: `${prefix}-${String(i).padStart(4, '0')}`,
    messageId: `false_${prefix}@g.us_${prefix.toUpperCase()}${i}_m@lid`,
    timestamp: new Date(start + i * 60_000),
    buffer: webp({ salt: `${prefix}${i}` })
  }));
}

async function drainBackfill(h) {
  const results = [];
  for (let i = 0; i < 50; i++) {
    const result = await runBackfillPage(h.context, SCOPE);
    results.push(result);
    if (result.kind !== 'page') break;
  }
  return results;
}

test('backfills every covered chat from the archive in pages and dedupes against live and repeated stickers', async () => {
  const groupA = archivedItems('a', 55);
  groupA[3] = { ...groupA[3], fromMe: true };
  groupA[4] = { ...groupA[4], mimeType: 'application/was' };
  groupA[5] = { ...groupA[5], buffer: groupA[6].buffer };
  const groupB = archivedItems('b', 2);
  const h = setup({ archiveChats: { 'a@g.us': groupA, 'b@g.us': groupB } });
  const results = await drainBackfill(h);
  assert.deepEqual(results.map(r => r.kind === 'page' ? `${r.chatId}:${r.listed}:${r.imported}` : r.kind),
    ['a@g.us:50:47', 'a@g.us:5:5', 'b@g.us:2:2', 'done']);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers').n, 54, '55 + 2 minus own, non-WebP and one duplicate');
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM sticker_sightings WHERE scope_id = 'scope-1'").n, 55);
  assert.equal(h.media.stored.size, 54, 'duplicate staged copy deleted');
  assert.equal(h.archived.calls.list[1].afterMediaId, 'a-0049');
  assert.equal(await startBackfill(h.context, SCOPE), true);
  await drainBackfill(h);
  assert.ok(h.db.get('SELECT completed_at FROM backfill_scopes').completed_at, 'scope marked complete');
  // A second pass touches nothing and does not stage again.
  const staged = h.archived.calls.stage.length;
  await drainBackfill(h);
  assert.equal(h.archived.calls.stage.length, staged);
  // Status reports the import; oldest archived stickers are sent first.
  assert.match((await h.command('status')).text, /"total":54.*"archived":54/);
  const first = (await h.command('send', { args: ['1'] })).pluginActions[0];
  const oldest = h.db.get("SELECT s.sha256 FROM sticker_scopes ss JOIN stickers s ON s.id = ss.sticker_id ORDER BY ss.first_seen_at LIMIT 1").sha256;
  assert.ok(first.file.filename.startsWith(oldest.slice(0, 16)));
});

test('backfill uses the archive hash to skip staging stickers already collected, and respects forgotten stickers', async () => {
  const items = archivedItems('c', 2);
  const h = setup({ archiveChats: { 'c@g.us': items } });
  const live = h.addSticker(items[0].buffer);
  await collectSticker(h.context, SCOPE, live);
  const crypto = require('node:crypto');
  items[0].sha256 = crypto.createHash('sha256').update(items[0].buffer).digest('hex');
  items[1].sha256 = crypto.createHash('sha256').update(items[1].buffer).digest('hex');
  await h.command('forget', { replyTo: live.id });
  await drainBackfill(h);
  assert.deepEqual(h.archived.calls.stage, ['c-0001'], 'known/forgotten hash is not staged');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers').n, 1, 'forgotten sticker not re-collected');
});

test('backfill starts once per scope on the first message, on subscribe, and on every startup', async () => {
  const h = setup({ archiveChats: { 'a@g.us': archivedItems('a', 1) } });
  await h.hooks.onMessage({ scopeId: SCOPE, message: { type: 'chat', context: 'group' } });
  await h.hooks.onMessage({ scopeId: SCOPE, message: { type: 'chat', context: 'group' } });
  const starts = () => h.jobs.filter(j => j.jobName === 'sticker-thief.backfill').length;
  assert.equal(starts(), 1);
  assert.equal(h.jobs[0].dedupeKey, 'sticker-thief:backfill:scope-1:start');
  await h.command('subscribe');
  assert.equal(starts(), 1);
  await h.hooks.onRuntimeReady({});
  assert.equal(starts(), 2, 'startup resumes or rescans');
  const off = setup({ config: { backfillArchive: false }, archiveChats: { 'a@g.us': archivedItems('a', 1) } });
  assert.equal(await startBackfill(off.context, SCOPE), false);
  assert.deepEqual(await runBackfillPage(off.context, SCOPE), { kind: 'skipped', reason: 'backfill-disabled' });
  const noArchive = setup();
  assert.equal(await startBackfill(noArchive.context, SCOPE), false, 'older cores without archivedStickers');
});

// --- 0.3.0: native sticker packs -------------------------------------------

test('delivers as sticker packs of up to 60, still and animated apart, leftovers individually', async () => {
  const h = setup();
  for (let i = 0; i < 122; i++) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: `p${i}` })));
  for (let i = 0; i < 4; i++) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: `a${i}`, animated: true })));
  const first = await h.command('send');
  assert.match(first.text, /sendingPacks.*"count":126.*"packs":3/);
  assert.equal(first.pluginActions.length, 1);
  const [pack] = first.pluginActions;
  assert.equal(pack.type, 'message.sendStickerPack');
  assert.equal(pack.chatId, 'alice@lid');
  assert.equal(pack.pack.stickers.length, 60);
  assert.match(pack.pack.id, /^[0-9a-f-]{36}-1$/);
  assert.match(pack.pack.name, /packName.*2026-11-01.*\(1\/3\)$/);
  assert.equal(pack.pack.publisher, 'Sticker Thief');
  assert.match(pack.idempotencyKey, /^sticker-thief:[0-9a-f-]{36}:pack:1$/);
  const job = h.jobs.find(j => j.jobName === 'sticker-thief.deliver');
  assert.equal(job.runAt.getTime() - Date.parse('2026-11-01T12:00:00.000Z'), 15_000);
  const batches = await drainDeliveries(h);
  const shape = batches.map(b => b.map(a => a.type === 'message.sendStickerPack' ? `pack:${a.pack.stickers.length}` : 'single').join(','));
  // 122 still -> 60 + 60 + 2 left over; 4 animated -> one pack of 4; the 2 leftovers go individually.
  assert.deepEqual(shape, ['pack:60', 'pack:4', 'single,single']);
  const animatedPack = batches[1][0];
  const animatedShas = new Set(h.db.all('SELECT sha256 FROM stickers WHERE animated = 1').map(r => r.sha256.slice(0, 16)));
  assert.ok(animatedPack.pack.stickers.every(s => animatedShas.has(s.file.filename.slice(0, 16))), 'animated pack holds only animated stickers');
  assert.match(animatedPack.pack.name, /\(3\/3\)$/);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM deliveries').n, 126);
});

test('a single small pack is not numbered and two stickers go out individually', async () => {
  const h = setup();
  for (let i = 0; i < 5; i++) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: `q${i}` })));
  const res = await h.command('send', { args: ['3'] });
  assert.equal(res.pluginActions[0].type, 'message.sendStickerPack');
  assert.match(res.pluginActions[0].pack.name, /packName.*2026-11-01"\}$/);
  const two = await h.command('send');
  assert.deepEqual(two.pluginActions.map(a => a.type), ['message.sendSticker', 'message.sendSticker']);
  assert.match(two.text, /\.sending \{"count":2/);
});

test('digests arrive as packs after the header', async () => {
  const h = setup({ members: ['alice'] });
  for (let i = 0; i < 5; i++) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: `g${i}` })));
  await h.command('subscribe', { args: ['daily'] });
  h.setNow('2026-11-02T12:00:00.000Z');
  const actions = await runDigest(h.context, { ...h.jobs[0], scopeId: SCOPE, managementMode: 'ASSIST' });
  assert.deepEqual(actions.map(a => a.type), ['message.sendText', 'message.sendStickerPack']);
  assert.equal(actions[1].pack.stickers.length, 5);
});

// --- 0.4.0: pack rules and resend -----------------------------------------

test('stickers outside WhatsApp pack rules still go in the pack (the host conforms them)', async () => {
  const h = setup();
  for (let i = 0; i < 4; i++) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: `ok${i}` })));
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'small', width: 240, height: 240 })));
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'big' })));
  h.db.run('UPDATE stickers SET size_bytes = ? WHERE id = (SELECT max(id) FROM stickers)', 150 * 1024);
  const first = await h.command('send');
  assert.match(first.text, /sendingPacks.*"count":6.*"packs":1/);
  assert.equal(first.pluginActions[0].pack.stickers.length, 6);
  assert.deepEqual(await drainDeliveries(h), []);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM deliveries').n, 6);
});

test('resend sends the most recently received stickers again, in collection order', async () => {
  const h = setup();
  assert.match((await h.command('resend')).text, /nothingToResend/);
  for (let i = 0; i < 5; i++) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: `r${i}` })));
  const firstFilenames = (await h.command('send')).pluginActions[0].pack.stickers.map(s => s.file.filename);
  assert.match((await h.command('send')).text, /noNewStickers/);
  const all = await h.command('resend');
  assert.equal(all.pluginActions[0].type, 'message.sendStickerPack');
  assert.deepEqual(all.pluginActions[0].pack.stickers.map(s => s.file.filename), firstFilenames);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM deliveries').n, 5, 'recorded again after resending');
  const two = await h.command('resend', { args: ['2'] });
  assert.deepEqual(two.pluginActions.map(a => a.type), ['message.sendSticker', 'message.sendSticker']);
  assert.match((await h.command('send')).text, /noNewStickers/);
  assert.match((await h.command('resend', { identityId: 'bob' })).text, /nothingToResend/, 'per member');
});

// --- 0.7.0: bot account favourites ----------------------------------------
const { runFavorites, scheduleFavorites } = require('../dist/service.js');

test('new stickers are favourited on the bot account in batches of 20', async () => {
  const h = setup();
  for (let i = 0; i < 45; i++) await h.hooks.onMessage({ scopeId: SCOPE, message: h.addSticker(webp({ salt: `f${i}` })) });
  const favJobs = () => h.jobs.filter(j => j.jobName === 'sticker-thief.favorite');
  assert.ok(favJobs().length >= 1);
  assert.equal(favJobs()[0].dedupeKey, 'sticker-thief:favorite:scope-1', 'repeated triggers coalesce on one key');
  assert.deepEqual(await runFavorites(h.context, SCOPE), { kind: 'favorited', count: 20, more: true });
  assert.deepEqual(await runFavorites(h.context, SCOPE), { kind: 'favorited', count: 20, more: true });
  assert.deepEqual(await runFavorites(h.context, SCOPE), { kind: 'favorited', count: 5, more: false });
  assert.deepEqual(await runFavorites(h.context, SCOPE), { kind: 'favorited', count: 0, more: false });
  assert.deepEqual(h.favoriteCalls.map(c => [c.count, c.favorite, c.scopeId]), [[20, true, SCOPE], [20, true, SCOPE], [5, true, SCOPE]]);
  assert.ok(h.favoriteCalls.flatMap(c => c.files).every(f => f.mimeType === 'image/webp' && Buffer.isBuffer(f.buffer)));
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers WHERE favorited_at IS NOT NULL').n, 45);
});

test('startup catches up favourites; the setting and older cores turn them off', async () => {
  const h = setup();
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'old' })));
  await h.hooks.onRuntimeReady({});
  assert.ok(h.jobs.some(j => j.jobName === 'sticker-thief.favorite'));
  const off = setup({ config: { favoriteOnBotAccount: false } });
  await collectSticker(off.context, SCOPE, off.addSticker(webp({ salt: 'x' })));
  assert.equal(await scheduleFavorites(off.context, SCOPE), false);
  assert.deepEqual(await runFavorites(off.context, SCOPE), { kind: 'skipped', reason: 'favorites-disabled' });
  const old = setup();
  delete old.context.accountStickers;
  assert.equal(await scheduleFavorites(old.context, SCOPE), false);
});

test('archive backfill favourites imported stickers too', async () => {
  const h = setup({ archiveChats: { 'a@g.us': archivedItems('fa', 3) } });
  await drainBackfill(h);
  assert.ok(h.jobs.some(j => j.jobName === 'sticker-thief.favorite'));
  await runFavorites(h.context, SCOPE);
  assert.equal(h.favoriteCalls[0].count, 3);
});

test('forgetting a favourited sticker removes it from the bot favourites', async () => {
  const h = setup();
  const message = h.addSticker(webp({ salt: 'gone' }));
  await collectSticker(h.context, SCOPE, message);
  await runFavorites(h.context, SCOPE);
  await h.command('forget', { replyTo: message.id });
  assert.deepEqual(h.favoriteCalls.map(c => [c.count, c.favorite]), [[1, true], [1, false]]);
  assert.equal(h.media.stored.size, 0);
});

// --- 0.8.0: archive rescans and the re-import action ------------------------

test('a rescan finds a sticker whose random media id sorts before the cursor; a plain resume does not', async () => {
  const items = archivedItems('r', 3);
  const h = setup({ archiveChats: { 'r@g.us': items } });
  await drainBackfill(h);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers').n, 3);
  // Arrives later, but its id lands before the saved cursor ('r-0002').
  items.unshift({ ...archivedItems('a', 1)[0], buffer: webp({ salt: 'late' }) });
  await startBackfill(h.context, SCOPE);
  await drainBackfill(h);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers').n, 3, 'resume from the cursor cannot see it');
  await startBackfill(h.context, SCOPE, { rescan: true });
  assert.deepEqual(JSON.parse(JSON.stringify(h.db.all('SELECT after_media_id, done FROM backfill_chats'))), [{ after_media_id: null, done: 0 }], 'cursor cleared');
  const staged = h.archived.calls.stage.length;
  await drainBackfill(h);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers').n, 4, 'rescan collects it');
  assert.equal(h.archived.calls.stage.length, staged + 1, 'known stickers are skipped without staging');
});

test('finishing a pass queues the next rescan a day later, and startup rescans', async () => {
  const h = setup({ archiveChats: { 'd@g.us': archivedItems('d', 1) } });
  await drainBackfill(h);
  const rescan = h.jobs.find(j => j.dedupeKey === 'sticker-thief:backfill:scope-1:rescan');
  assert.ok(rescan, 'daily rescan queued');
  assert.deepEqual(rescan.payload, { rescan: true });
  assert.equal(rescan.runAt.getTime() - h.context.now().getTime(), 24 * 60 * 60 * 1000);
  assert.equal(rescan.replaceRetainedTerminalJob, true);
  h.db.run("UPDATE backfill_chats SET done = 1, after_media_id = 'd-0000'");
  await h.hooks.onPluginJob({ jobName: 'sticker-thief.backfill', scopeId: SCOPE, payload: { rescan: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(h.db.all('SELECT after_media_id, done FROM backfill_chats'))), [{ after_media_id: null, done: 0 }], 'the job resets cursors');
  assert.equal(h.jobs.filter(j => j.dedupeKey === 'sticker-thief:backfill:scope-1:start').length, 1);
  h.db.run("UPDATE backfill_chats SET done = 1, after_media_id = 'd-0000'");
  await h.hooks.onRuntimeReady({});
  assert.equal(h.db.get('SELECT done FROM backfill_chats').done, 0, 'startup rescans');
});

test('the re-import action queues a rescan, reports status and is audited; disabled scopes refuse', async () => {
  const h = setup({ archiveChats: { 'e@g.us': archivedItems('e', 2) } });
  await startBackfill(h.context, SCOPE);
  await drainBackfill(h);
  const audits = [];
  const context = { ...h.context, audit: { async record(entry) { audits.push(entry); } } };
  const [action] = plugin.registerExternalActions(context);
  assert.equal(action.actionId, 'official.sticker-thief.reimportArchive');
  assert.equal(await action.resolveScopeId({ scopeId: SCOPE, confirm: true }), SCOPE);
  const result = await action.handler({ scopeId: SCOPE, runtimeBindingId: 'bot-1', confirm: true });
  assert.equal(result.queued, true);
  assert.equal(result.collected, 2);
  assert.equal(result.imported, 2);
  assert.equal(result.pendingFavorites, 2, 'nothing favourited yet in this harness');
  assert.ok(result.lastCompletedAt);
  assert.equal(h.db.get('SELECT done FROM backfill_chats').done, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'sticker-thief.reimport_archive');
  await assert.rejects(() => action.handler({ confirm: true }), /scopeId/);
  const off = setup({ config: { backfillArchive: false }, archiveChats: { 'e@g.us': archivedItems('e', 1) } });
  const [offAction] = plugin.registerExternalActions({ ...off.context, audit: { async record() {} } });
  assert.deepEqual((await offAction.handler({ scopeId: SCOPE })).queued, false);
  assert.equal((await offAction.handler({ scopeId: SCOPE })).reason, 'backfill-disabled');
});
