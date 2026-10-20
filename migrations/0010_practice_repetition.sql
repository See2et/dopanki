-- Fence legacy mutation batches before changing the meaning of member state.
-- Legacy updates use revision; their whole batch must fail after cutover.
ALTER TABLE practice_sessions RENAME COLUMN revision TO state_revision;

-- Short-term custom-practice repetition is separate from cards / regular FSRS.
ALTER TABLE practice_sessions ADD COLUMN answer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE practice_members ADD COLUMN completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1));
ALTER TABLE practice_members ADD COLUMN retry_after INTEGER;
ALTER TABLE practice_members ADD COLUMN again_seen INTEGER NOT NULL DEFAULT 0 CHECK(again_seen IN (0,1));
ALTER TABLE practice_events ADD COLUMN previous_state TEXT;

-- Preserve the meaning of answers already submitted under single-pass practice.
-- In particular, do not reopen an already completed legacy round.
UPDATE practice_members SET completed=1,again_seen=CASE WHEN rating=1 THEN 1 ELSE 0 END WHERE rating IS NOT NULL;
