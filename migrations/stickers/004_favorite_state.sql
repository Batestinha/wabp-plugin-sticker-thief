-- Favourite runs that failed on the transport (typically while WhatsApp waits
-- for the phone to repair the favourites list). The plugin backs off from this
-- row and the operator console shows why stickers are still waiting.
CREATE TABLE IF NOT EXISTS favorite_state (
  scope_id TEXT PRIMARY KEY,
  failing_since TEXT NOT NULL,
  last_error TEXT NOT NULL,
  last_error_at TEXT NOT NULL,
  next_retry_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
