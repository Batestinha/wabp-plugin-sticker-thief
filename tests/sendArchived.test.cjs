const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const plugin = require('../dist/index.js').default;
const { sendArchivedSticker, sendArchivedStickerPack } = require('../dist/service.js');
const { harness, webp } = require('./helpers.cjs');

const SCOPE = 'scope-1';
const CHAT = 'group@g.us';
const SHA = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function request(buffer, overrides = {}) {
  return {
    scopeId: SCOPE,
    identityId: 'alice',
    deliveryChatId: 'alice@lid',
    chatId: CHAT,
    groupId: CHAT,
    groupWid: CHAT,
    mediaId: 'media-1',
    stanzaId: 'STANZA1',
    sha256: SHA(buffer),
    mimeType: 'image/webp',
    managementMode: 'ASSIST',
    intent: 'send',
    ...overrides
  };
}

function setup(buffer, options = {}) {
  const sends = [];
  const h = harness({
    members: options.members ?? ['alice'],
    archiveChats: { [CHAT]: [{ mediaId: 'media-1', messageId: 'false_group@g.us_STANZA1_member@lid', buffer, mimeType: 'image/webp' }] },
    ...options.harness
  });
  if (options.coveredMode) {
    h.context.coveredGroupsForScope = async () => [{ scopeId: SCOPE, groupId: CHAT, groupWid: CHAT, managementMode: options.coveredMode }];
  }
  return {
    h, sends,
    send: (overrides = {}) => sendArchivedSticker(h.context, request(buffer, overrides), {
      executeSend: async (file) => { sends.push(file); }
    })
  };
}

test('a current member receives one archived sticker, and a second click does not send or stage again', async () => {
  const buffer = webp({ salt: 'member' });
  const { h, sends, send } = setup(buffer);
  assert.equal((await send({ intent: 'offer' })).result, 'offered');
  assert.equal(h.archived.calls.stage.length, 0, 'offer does not stage');
  assert.equal(h.archived.calls.list.length, 0, 'offer does not list the archive');
  assert.equal(sends.length, 0);
  const sent = await send();
  assert.equal(sent.result, 'sent');
  assert.deepEqual(h.archived.calls.stage, ['media-1']);
  assert.equal(h.archived.calls.list.length, 0);
  assert.equal(sends.length, 1);
  assert.equal(h.media.stored.size, 1);
  const again = await send({ stanzaId: 'STANZA2' });
  assert.equal(again.result, 'already-sent');
  assert.deepEqual(h.archived.calls.stage, ['media-1'], 'the collected file is reused');
  assert.equal(sends.length, 1);
  assert.equal(h.media.stored.size, 1);
});

test('a sticker already collected is not copied again', async () => {
  const buffer = webp({ salt: 'known' });
  const { h, send } = setup(buffer, { members: ['alice', 'bob'] });
  assert.equal((await send()).result, 'sent');
  h.archived.calls.stage.length = 0;
  const other = await send({ identityId: 'bob', deliveryChatId: 'bob@lid', mediaId: 'media-2', stanzaId: 'STANZA9' });
  assert.equal(other.result, 'sent');
  assert.deepEqual(h.archived.calls.stage, [], 'known hash is not staged');
  assert.equal(h.media.stored.size, 1);
});

test('a non-member, a forgotten sticker, and an observe-only scope do not stage or send', async () => {
  const buffer = webp({ salt: 'refuse' });
  const stranger = setup(buffer, { members: ['bob'] });
  assert.equal((await stranger.send()).result, 'refused');
  assert.equal((await stranger.send()).reason, 'not-a-member');
  assert.equal(stranger.h.archived.calls.stage.length, 0);
  assert.equal(stranger.sends.length, 0);

  const forgotten = setup(buffer);
  forgotten.h.db.run(
    'INSERT INTO forgotten_stickers (scope_id, sha256, forgotten_at) VALUES (?, ?, ?)',
    SCOPE, SHA(buffer), '2026-11-01T00:00:00.000Z'
  );
  assert.equal((await forgotten.send()).reason, 'forgotten');
  assert.equal(forgotten.h.archived.calls.stage.length, 0);
  assert.equal(forgotten.sends.length, 0);

  const observe = setup(buffer);
  assert.equal((await observe.send({ managementMode: 'OBSERVE' })).reason, 'observe-only');
  const covered = setup(buffer, { coveredMode: 'OBSERVE' });
  assert.equal((await covered.send({ managementMode: 'ASSIST' })).reason, 'observe-only');
  assert.equal(observe.h.archived.calls.stage.length + covered.h.archived.calls.stage.length, 0);
  assert.equal(observe.sends.length + covered.sends.length, 0);
});

test('a hash that does not match the archived bytes is deleted and not sent', async () => {
  const buffer = webp({ salt: 'mismatch' });
  const { h, sends, send } = setup(buffer);
  const result = await send({ sha256: 'ab'.repeat(32) });
  assert.equal(result.reason, 'hash-mismatch');
  assert.deepEqual(h.archived.calls.stage, ['media-1']);
  assert.equal(h.media.stored.size, 0);
  assert.equal(sends.length, 0);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM stickers').n, 0);
});

test('the registered action sends only through the host operator, to the delivery chat the host supplied', async () => {
  const buffer = webp({ salt: 'action' });
  const { h } = setup(buffer);
  const actions = [];
  const context = {
    ...h.context,
    audit: { async record() {} },
    operator: { async executeActions(input) { actions.push(input); } }
  };
  const action = plugin.registerExternalActions(context).find((entry) => entry.actionId === 'official.sticker-thief.sendArchivedSticker');
  assert.ok(action);
  const input = request(buffer);
  assert.equal((await action.handler(input)).result, 'sent');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].actions[0].type, 'message.sendSticker');
  assert.equal(actions[0].actions[0].chatId, 'alice@lid');
  assert.equal(actions[0].actions[0].idempotencyKey, `sticker-thief:archive:${SCOPE}:alice:${SHA(buffer)}`);
  assert.equal(actions[0].groupWid, CHAT);
});

test('a pack is offered without staging and sent once, to the member chat', async () => {
  const first = webp({ salt: 'pack-a' });
  const second = webp({ salt: 'pack-b' });
  const stickers = [
    { mediaId: 'media-a', sha256: SHA(first), mimeType: 'image/webp' },
    { mediaId: 'media-b', sha256: SHA(second), mimeType: 'image/webp', emoji: '🙂' }
  ];
  const { h } = setup(first, { harness: { archiveChats: { [CHAT]: [
    { mediaId: 'media-a', messageId: 'false_group@g.us_PACK_member@lid', buffer: first, mimeType: 'image/webp' },
    { mediaId: 'media-b', messageId: 'false_group@g.us_PACK_member@lid', buffer: second, mimeType: 'image/webp' }
  ] } } });
  const sends = [];
  const input = {
    scopeId: SCOPE, identityId: 'alice', deliveryChatId: 'alice@lid', chatId: CHAT, groupId: CHAT, groupWid: CHAT,
    managementMode: 'ASSIST', stanzaId: 'PACK', name: 'Linha', stickers, intent: 'offer'
  };
  assert.equal((await sendArchivedStickerPack(h.context, input)).result, 'offered');
  assert.equal(h.archived.calls.stage.length, 0);
  const sent = await sendArchivedStickerPack(h.context, { ...input, intent: 'send' }, {
    executeSend: async (pack) => { sends.push(pack); }
  });
  assert.equal(sent.result, 'sent');
  assert.deepEqual(h.archived.calls.stage, ['media-a', 'media-b']);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].name, 'Linha');
  assert.equal(sends[0].stickers.length, 2);
  assert.equal(sends[0].stickers[1].emoji, '🙂');
  const again = await sendArchivedStickerPack(h.context, { ...input, intent: 'send' }, {
    executeSend: async (pack) => { sends.push(pack); }
  });
  assert.equal(again.result, 'already-sent');
  assert.equal(sends.length, 1);
  assert.deepEqual(h.archived.calls.stage, ['media-a', 'media-b']);
});

test('a pack with one forgotten sticker is not sent', async () => {
  const first = webp({ salt: 'pack-forgotten' });
  const { h, sends } = setup(first);
  h.db.run('INSERT INTO forgotten_stickers (scope_id, sha256, forgotten_at) VALUES (?, ?, ?)', SCOPE, SHA(first), '2026-11-01T00:00:00.000Z');
  const result = await sendArchivedStickerPack(h.context, {
    scopeId: SCOPE, identityId: 'alice', deliveryChatId: 'alice@lid', chatId: CHAT, groupId: CHAT, groupWid: CHAT,
    managementMode: 'ASSIST', stanzaId: 'PACK', name: 'Linha', intent: 'send',
    stickers: [{ mediaId: 'media-1', sha256: SHA(first), mimeType: 'image/webp' }]
  }, { executeSend: async () => { sends.push(true); } });
  assert.equal(result.reason, 'forgotten');
  assert.equal(sends.length, 0);
  assert.equal(h.archived.calls.stage.length, 0);
});

test('the pack action sends a native pack only to the delivery chat', async () => {
  const buffer = webp({ salt: 'pack-action' });
  const { h } = setup(buffer);
  const actions = [];
  const context = {
    ...h.context,
    audit: { async record() {} },
    operator: { async executeActions(input) { actions.push(input); } }
  };
  const action = plugin.registerExternalActions(context).find((entry) => entry.actionId === 'official.sticker-thief.sendArchivedStickerPack');
  assert.ok(action);
  const result = await action.handler({
    scopeId: SCOPE, identityId: 'alice', deliveryChatId: 'alice@lid', chatId: CHAT, groupId: CHAT, groupWid: CHAT,
    managementMode: 'ASSIST', stanzaId: 'PACK', name: 'Linha', intent: 'send',
    stickers: [{ mediaId: 'media-1', sha256: SHA(buffer), mimeType: 'image/webp' }]
  });
  assert.equal(result.result, 'sent');
  assert.equal(actions[0].actions[0].type, 'message.sendStickerPack');
  assert.equal(actions[0].actions[0].chatId, 'alice@lid');
  assert.equal(actions[0].actions[0].pack.name, 'Linha');
  assert.equal(actions[0].actions[0].pack.stickers.length, 1);
});
