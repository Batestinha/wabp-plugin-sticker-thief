const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = path.join(__dirname, '../migrations/stickers');

function openDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-thief-'));
  const filePath = path.join(dir, 'stickers.sqlite');
  const sqlite = new DatabaseSync(filePath);
  for (const file of fs.readdirSync(MIGRATIONS).sort()) sqlite.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  const db = {
    name: 'stickers', filePath,
    exec: sql => sqlite.exec(sql),
    prepare: sql => sqlite.prepare(sql),
    get: (sql, ...args) => sqlite.prepare(sql).get(...args),
    all: (sql, ...args) => sqlite.prepare(sql).all(...args),
    run: (sql, ...args) => sqlite.prepare(sql).run(...args),
    close: () => sqlite.close(),
    transaction(operation) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const value = operation(); sqlite.exec('COMMIT'); return value; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return { db, registry: { open: name => { if (name !== 'stickers') throw new Error('undeclared db ' + name); return db; }, closeAll() {} } };
}

/** A minimal valid-header WebP: VP8X canvas, optional animation flag. */
function webp({ width = 512, height = 512, animated = false, salt = '' } = {}) {
  const payload = Buffer.alloc(10 + 16 + salt.length);
  payload[0] = animated ? 0x02 : 0;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  payload.write(salt, 26);
  const body = Buffer.concat([Buffer.from('WEBPVP8X'), Buffer.alloc(4), payload]);
  body.writeUInt32LE(payload.length, 8);
  const out = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), body]);
  out.writeUInt32LE(body.length, 4);
  return out;
}

function mediaStore(filesByMessageId) {
  const stored = new Map();
  let next = 0;
  return {
    stored,
    async stageMessage(messageId, options = {}) {
      const file = filesByMessageId.get(messageId);
      if (!file) return { ok: false, reason: 'not-found', message: 'missing' };
      if (options.maxBytes !== undefined && file.buffer.length > options.maxBytes) {
        return { ok: false, reason: 'too-large', message: 'big' };
      }
      const media = {
        id: `media-${++next}`, pluginId: 'official.sticker-thief', messageId,
        filename: options.fallbackFilename ?? 'x', mimeType: file.mimeType, sizeBytes: file.buffer.length,
        sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), createdAt: new Date().toISOString()
      };
      stored.set(media.id, { media, buffer: file.buffer });
      return { ok: true, media };
    },
    async read(id) { return stored.get(id); },
    async delete(id) { stored.delete(id); }
  };
}

let messageSeq = 0;
function stickerMessage(overrides = {}) {
  const stanza = `STANZA${++messageSeq}`;
  return {
    id: `false_group@g.us_${stanza}_member@lid`, chatId: 'group@g.us', authorWid: 'member@lid', senderWid: 'member@lid',
    fromMe: false, timestamp: new Date(), type: 'sticker', body: '', hasMedia: true,
    media: { mimeType: 'image/webp' }, links: [], mentions: [], context: 'group', ...overrides
  };
}

function harness({ config = {}, members } = {}) {
  const { db, registry } = openDatabase();
  const files = new Map();
  const media = mediaStore(files);
  const jobs = [];
  let clock = new Date('2026-11-01T12:00:00.000Z');
  const handlers = new Map();
  const context = {
    pluginId: 'official.sticker-thief',
    databases: registry,
    mediaStore: media,
    now: () => clock,
    configFor: async () => ({ enabled: true, ...config }),
    enqueuePluginJob: async job => { jobs.push(job); },
    resolveStableIdentityById: async identityId => ({ identityId, deliveryChatId: `${identityId}@lid` }),
    currentMemberIdentityIdsForScope: members ? async () => members : undefined,
    i18n: { translatorForIdentity: async () => (key, params) => `${key}${params ? ' ' + JSON.stringify(params) : ''}` },
    router: { register(namespace, sub, metadata, handler) { handlers.set(`${namespace} ${sub}`, { metadata, handler }); } }
  };
  return {
    db, files, media, jobs, handlers, context,
    setNow(date) { clock = new Date(date); },
    addSticker(buffer, overrides = {}) {
      const message = stickerMessage(overrides);
      files.set(message.id, { buffer, mimeType: overrides.mimeType ?? 'image/webp' });
      return message;
    },
    async command(name, { args = [], identityId = 'alice', scopeId = 'scope-1', managementMode = 'ASSIST', replyTo } = {}) {
      const entry = handlers.get(`stickers ${name}`);
      if (!entry) throw new Error('unregistered command ' + name);
      return entry.handler({
        message: { id: 'cmd', chatId: 'group@g.us', context: 'group', ...(replyTo ? { replyTo: { messageId: replyTo } } : {}) },
        command: { namespace: 'stickers', subcommand: name, args },
        actor: { wid: `${identityId}@lid`, fromMe: false, identityAddress: { identityId, deliveryChatId: `${identityId}@lid` } },
        scopeId, managementMode, locale: 'en',
        t: (key, params) => `${key}${params ? ' ' + JSON.stringify(params) : ''}`
      });
    }
  };
}

module.exports = { harness, webp };
