-- One cursor per group. next_index is the next line to send; last_sent_at
-- starts the cooldown. A missed roll does not write a row.
CREATE TABLE group_announcements (
  scope_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  last_sent_at TEXT,
  next_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, chat_id)
);
