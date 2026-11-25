const { test } = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../dist/index.js').default;
const { harness, webp } = require('./helpers.cjs');

const SCOPE = 'scope-1';
const LINES = ['Got one.', 'Got another.', 'And another.'];

function setup(config = {}, random = () => 0, catalog) {
  const h = harness({ config });
  h.context.random = random;
  if (catalog) {
    h.context.i18n.translatorForScope = async () => (key) => catalog[key] ?? key;
  }
  return { ...h, hooks: plugin.registerHooks(h.context) };
}

async function steal(h, { salt, chatId = 'group@g.us', managementMode = 'ASSIST' } = {}) {
  const message = h.addSticker(webp({ salt }), { chatId });
  const actions = await h.hooks.onMessage({ scopeId: SCOPE, managementMode, message }) ?? [];
  return { message, actions };
}

function linesOf(actions) {
  return actions.filter((action) => action.type === 'message.sendText').map((action) => action.text);
}

test('stays quiet until lines and a chance are set', async () => {
  const quiet = setup();
  assert.deepEqual(linesOf((await steal(quiet, { salt: 'a' })).actions), []);
  const noChance = setup({ announceMessages: LINES, announceChancePercent: 0 });
  assert.deepEqual(linesOf((await steal(noChance, { salt: 'b' })).actions), []);
  const noLines = setup({ announceMessages: ['   '], announceChancePercent: 100 });
  assert.deepEqual(linesOf((await steal(noLines, { salt: 'c' })).actions), []);
});

test('rotates the lines in each group and wraps', async () => {
  const h = setup({ announceMessages: LINES, announceChancePercent: 100, announceCooldownMinutes: 0 });
  const sent = [];
  for (const salt of ['a', 'b', 'c', 'd']) sent.push(...linesOf((await steal(h, { salt })).actions));
  assert.deepEqual(sent, ['Got one.', 'Got another.', 'And another.', 'Got one.']);
  const again = await steal(h, { salt: 'a' });
  assert.deepEqual(linesOf(again.actions), []);
});

test('a miss does not start the cooldown', async () => {
  const rolls = [0.6, 0.1];
  const h = setup(
    { announceMessages: LINES, announceChancePercent: 50, announceCooldownMinutes: 60 },
    () => rolls.shift()
  );
  assert.deepEqual(linesOf((await steal(h, { salt: 'miss' })).actions), []);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM group_announcements').n, 0);
  const hit = await steal(h, { salt: 'hit' });
  assert.deepEqual(linesOf(hit.actions), ['Got one.']);
  assert.equal(hit.actions[0].chatId, 'group@g.us');
  assert.match(hit.actions[0].idempotencyKey, /^sticker-thief:boast:scope-1:group@g\.us:\d+$/);
});

test('each group keeps its own cursor and cooldown', async () => {
  const h = setup({ announceMessages: LINES, announceChancePercent: 100, announceCooldownMinutes: 60 });
  assert.deepEqual(linesOf((await steal(h, { salt: 'a1', chatId: 'a@g.us' })).actions), ['Got one.']);
  assert.deepEqual(linesOf((await steal(h, { salt: 'b1', chatId: 'b@g.us' })).actions), ['Got one.']);
  assert.deepEqual(linesOf((await steal(h, { salt: 'a2', chatId: 'a@g.us' })).actions), []);
  h.setNow('2026-11-01T13:00:00.000Z');
  assert.deepEqual(linesOf((await steal(h, { salt: 'a3', chatId: 'a@g.us' })).actions), ['Got another.']);
  assert.deepEqual(linesOf((await steal(h, { salt: 'b2', chatId: 'b@g.us' })).actions), ['Got another.']);
});

test('a filled Announce line replaces the old text list and keeps its slot', async () => {
  const key = 'official.sticker-thief.announce.line.2';
  const h = setup(
    { announceMessages: LINES, announceChancePercent: 100, announceCooldownMinutes: 0 },
    () => 0,
    { [key]: 'Got one, with a comma.' }
  );
  const hit = await steal(h, { salt: 'catalog' });
  assert.deepEqual(linesOf(hit.actions), ['Got one, with a comma.']);
  assert.deepEqual(hit.actions[0].messageSlot, { key, scopeId: SCOPE });
  const quiet = setup({ announceMessages: LINES, announceChancePercent: 100 }, () => 0, {
    'official.sticker-thief.announce.line.1': '   ',
    'official.sticker-thief.announce.line.2': key
  });
  assert.deepEqual(linesOf((await steal(quiet, { salt: 'blank' })).actions), LINES.slice(0, 1));
});

test('observe mode and a repeated sticker stay quiet', async () => {
  const h = setup({ announceMessages: LINES, announceChancePercent: 100, announceCooldownMinutes: 0 });
  const observed = await steal(h, { salt: 'seen', managementMode: 'OBSERVE' });
  assert.deepEqual(linesOf(observed.actions), []);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM group_announcements').n, 0);
  const first = await steal(h, { salt: 'live', managementMode: 'MANAGE' });
  assert.deepEqual(linesOf(first.actions), ['Got one.']);
  const repeat = await h.hooks.onMessage({ scopeId: SCOPE, managementMode: 'MANAGE', message: first.message }) ?? [];
  assert.deepEqual(linesOf(repeat), []);
  assert.equal(h.db.get('SELECT next_index FROM group_announcements').next_index, 1);
});
