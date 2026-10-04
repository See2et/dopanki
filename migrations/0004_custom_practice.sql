CREATE TABLE practice_sessions (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, deck_ids TEXT NOT NULL, ordering TEXT NOT NULL CHECK(ordering IN ('deck','shuffle')),
 round INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0, last_event_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE practice_members (
 session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE, round INTEGER NOT NULL,
 card_id TEXT NOT NULL, position INTEGER NOT NULL, rating INTEGER CHECK(rating BETWEEN 1 AND 4), event_id TEXT,
 PRIMARY KEY(session_id,round,card_id), UNIQUE(session_id,round,position)
);
CREATE TABLE practice_events (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
 round INTEGER NOT NULL, card_id TEXT NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 4),
 previous_event_id TEXT, undone INTEGER NOT NULL DEFAULT 0 CHECK(undone IN (0,1)), reviewed_at INTEGER NOT NULL
);
CREATE TABLE practice_receipts (id TEXT PRIMARY KEY, request TEXT NOT NULL, response TEXT NOT NULL);
CREATE TABLE practice_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
