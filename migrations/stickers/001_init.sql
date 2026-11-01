-- One row per distinct sticker file (content-addressed). The bytes live in the
-- plugin media store; media_id points at them.
CREATE TABLE stickers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL UNIQUE,
  media_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  animated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Which scopes have seen each sticker. Delivery is limited to the scope a
-- sticker was collected in, so members only receive stickers from their groups.
CREATE TABLE sticker_scopes (
  scope_id TEXT NOT NULL,
  sticker_id INTEGER NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (scope_id, sticker_id)
);
CREATE INDEX sticker_scopes_order ON sticker_scopes (scope_id, first_seen_at, sticker_id);

-- Message stanza ids that carried a sticker, so admins can forget a sticker by
-- quoting it.
CREATE TABLE sticker_sightings (
  scope_id TEXT NOT NULL,
  stanza_id TEXT NOT NULL,
  sticker_id INTEGER NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, stanza_id)
);

-- Stickers an admin removed; they are never collected again in that scope.
CREATE TABLE forgotten_stickers (
  scope_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  forgotten_at TEXT NOT NULL,
  actor_identity_id TEXT,
  PRIMARY KEY (scope_id, sha256)
);

CREATE TABLE subscriptions (
  scope_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  next_due_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, identity_id)
);

CREATE TABLE deliveries (
  scope_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  sticker_id INTEGER NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, identity_id, sticker_id)
);
