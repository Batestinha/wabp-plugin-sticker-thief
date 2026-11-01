-- Per-chat progress of the one-time chat archive backfill. after_media_id is
-- the archive media-id cursor; done chats are skipped on later passes.
CREATE TABLE backfill_chats (
  scope_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  after_media_id TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, chat_id)
);

-- One row per scope once a backfill has been requested, so live messages do
-- not re-trigger it.
CREATE TABLE backfill_scopes (
  scope_id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  completed_at TEXT
);
