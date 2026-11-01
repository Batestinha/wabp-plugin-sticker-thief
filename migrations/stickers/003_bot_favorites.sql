-- When each sticker was added to the bot account's favourite stickers
-- (synced to the bot account's devices). NULL = not yet favourited.
ALTER TABLE stickers ADD COLUMN favorited_at TEXT;
