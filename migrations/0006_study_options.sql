-- All these values control admission only; cards.schedule remains the FSRS truth.
CREATE TABLE study_generation (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO study_generation VALUES(1,0);
CREATE TRIGGER study_card_insert AFTER INSERT ON cards BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_card_update AFTER UPDATE ON cards BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_card_delete AFTER DELETE ON cards BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_deck_insert AFTER INSERT ON decks BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_deck_update AFTER UPDATE ON decks BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_deck_delete AFTER DELETE ON decks BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TABLE study_extras (
  deck_id TEXT NOT NULL, study_day INTEGER NOT NULL, new_extra INTEGER NOT NULL DEFAULT 0,
  review_extra INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(deck_id,study_day)
);
CREATE TABLE study_receipts (
  id TEXT PRIMARY KEY, operation TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE study_restarts (
  id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, scope TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  daily_review_limit INTEGER NOT NULL, backlog_per_day INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0, flattened INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, backlog_total INTEGER NOT NULL
);
CREATE INDEX study_restarts_deck ON study_restarts(deck_id,cancelled);
CREATE TABLE study_restart_members (
  restart_id TEXT NOT NULL REFERENCES study_restarts(id), card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, original_due INTEGER NOT NULL, available_at INTEGER NOT NULL,
  backlog INTEGER NOT NULL, answered_event_id TEXT,
  PRIMARY KEY(restart_id,card_id)
);
CREATE INDEX study_restart_availability ON study_restart_members(card_id,revision,answered_event_id);
CREATE TABLE study_previews (
  token TEXT PRIMARY KEY, deck_id TEXT NOT NULL, generation INTEGER NOT NULL, study_day INTEGER NOT NULL,
  daily_review_limit INTEGER NOT NULL, backlog_per_day INTEGER NOT NULL, flattened INTEGER NOT NULL,
  scope TEXT NOT NULL, assignments TEXT NOT NULL, summary TEXT NOT NULL
);
ALTER TABLE review_events ADD COLUMN restart_id TEXT;
ALTER TABLE review_events ADD COLUMN restart_backlog INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_events ADD COLUMN restart_available_at INTEGER;
CREATE TRIGGER study_event_insert AFTER INSERT ON review_events BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_event_update AFTER UPDATE ON review_events BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_extra_insert AFTER INSERT ON study_extras BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_extra_update AFTER UPDATE ON study_extras BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_restart_insert AFTER INSERT ON study_restarts BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_restart_update AFTER UPDATE ON study_restarts BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER study_collection_update AFTER UPDATE ON collections BEGIN UPDATE study_generation SET revision=revision+1 WHERE id=1; END;
-- A restart extra is charged to one shared granting subtree, including when studying a child.
ALTER TABLE review_events ADD COLUMN restart_extra_deck_id TEXT;
-- Ordinary surplus answers spend one shared category-specific grant, without spending baseline capacity.
ALTER TABLE review_events ADD COLUMN ordinary_extra_deck_id TEXT;
