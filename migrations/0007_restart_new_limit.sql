-- Preserve the new-card pause on existing restart plans. New UI choices are explicit.
ALTER TABLE study_restarts ADD COLUMN daily_new_limit INTEGER NOT NULL DEFAULT 0 CHECK(daily_new_limit BETWEEN 0 AND 10000);
ALTER TABLE study_previews ADD COLUMN daily_new_limit INTEGER NOT NULL DEFAULT 0 CHECK(daily_new_limit BETWEEN 0 AND 10000);
