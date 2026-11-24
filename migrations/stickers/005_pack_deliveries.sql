-- A pack send is one delivery, keyed by the digest of its sticker hashes.
-- Individual sticker deliveries stay in `deliveries` so the digest does not
-- resend those files, but they do not count as this pack having been sent.
CREATE TABLE pack_deliveries (
  scope_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, identity_id, digest)
);
