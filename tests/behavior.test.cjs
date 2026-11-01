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
  const h = setup();
  for (const salt of ['a', 'b', 'c']) await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt })));
  const first = await h.command('send', { args: ['2'] });
  assert.equal(first.pluginActions.length, 2);
  for (const action of first.pluginActions) {
    assert.equal(action.type, 'message.sendSticker');
    assert.equal(action.chatId, 'alice@lid');
    assert.equal(action.file.mimeType, 'image/webp');
    assert.ok(Buffer.isBuffer(action.file.buffer));
    assert.match(action.idempotencyKey, /^sticker-thief:scope-1:alice:[0-9a-f]{64}$/);
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

test('caps manual requests, hides animated stickers when configured and refuses OBSERVE scopes', async () => {
  const h = setup({ config: { manualSendLimit: 1, includeAnimated: false } });
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'still-1' })));
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'still-2' })));
  await collectSticker(h.context, SCOPE, h.addSticker(webp({ salt: 'moving', animated: true })));
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers WHERE animated = 1').n, 1);
  assert.match((await h.command('send', { managementMode: 'OBSERVE' })).text, /observeOnly/);
  assert.equal((await h.command('send', { args: ['10'] })).pluginActions.length, 1);
  assert.equal((await h.command('send')).pluginActions.length, 1);
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
  assert.equal(h.jobs.length, 2);
  assert.equal(h.jobs[1].dedupeKey, h.jobs[0].dedupeKey, 're-seeding reuses the pending slot key');
  assert.equal(h.jobs[1].replaceRetainedTerminalJob, true);
  assert.match((await h.command('unsubscribe')).text, /unsubscribed/);
  assert.match((await h.command('unsubscribe')).text, /notSubscribed/);
  assert.equal(await runDigest(h.context, { ...h.jobs[0], scopeId: SCOPE }), undefined);
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
