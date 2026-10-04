ALTER TABLE notes ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE note_types ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE decks ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cards ADD COLUMN suspended_queue INTEGER;
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE content_history (
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  before_data TEXT, after_data TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX content_history_entity ON content_history(entity,entity_id,created_at);
CREATE TABLE mutation_receipts (
  id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL
);
-- A failed guard aborts the entire D1 batch, including its receipt and history.
CREATE TABLE content_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
CREATE UNIQUE INDEX decks_unique_name ON decks(name);
