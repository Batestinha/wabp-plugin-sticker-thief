-- An explicit request for one sticker is remembered here.
-- Pack and subscription sends also write `deliveries`, and those rows must
-- not turn a later "send this sticker" into already-sent.
CREATE TABLE archive_sticker_sends (
  scope_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, identity_id, sha256)
);
