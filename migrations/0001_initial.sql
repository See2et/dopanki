PRAGMA foreign_keys = ON;
CREATE TABLE collections (
  id INTEGER PRIMARY KEY CHECK (id = 1), source_hash TEXT NOT NULL,
  metadata TEXT NOT NULL, warnings TEXT NOT NULL, imported_at TEXT NOT NULL
);
CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE note_types (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE notes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE cards (
  id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id),
  deck_id TEXT NOT NULL REFERENCES decks(id), ordinal INTEGER NOT NULL,
  queue INTEGER NOT NULL, state INTEGER NOT NULL, due INTEGER NOT NULL,
  schedule TEXT NOT NULL, original TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, last_event_id TEXT
);
CREATE INDEX cards_due ON cards(deck_id, queue, state, due);
CREATE TABLE imported_reviews (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), data TEXT NOT NULL);
CREATE INDEX imported_reviews_card ON imported_reviews(card_id);
CREATE TABLE review_events (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), deck_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4), reviewed_at INTEGER NOT NULL,
  before_state TEXT NOT NULL, after_state TEXT NOT NULL, after_revision INTEGER NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0,1))
);
CREATE INDEX review_events_daily ON review_events(deck_id, reviewed_at, undone);
CREATE TABLE media (name TEXT PRIMARY KEY, object_key TEXT NOT NULL);
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, since INTEGER NOT NULL);
