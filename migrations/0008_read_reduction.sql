-- Match revival and global current-day event predicates (the imported time index is in 0002).
CREATE INDEX cards_buried ON cards(queue) WHERE queue IN (-2,-3);
CREATE INDEX review_events_active_time ON review_events(reviewed_at) WHERE undone=0;
CREATE INDEX practice_events_active_time ON practice_events(reviewed_at) WHERE undone=0;

-- Rebuildable progress projection. Canonical histories are never changed or truncated.
-- One durable version per UTC date, including emptied dates, makes undo/deletion safe.
-- Floor to whole seconds before date(): SQLite otherwise rounds fractional milliseconds
-- near midnight into the next UTC day. Subtract one for negative fractional seconds.
CREATE TABLE progress_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO progress_clock VALUES(1,0);
CREATE TABLE progress_dirty (utc_day TEXT PRIMARY KEY, revision INTEGER NOT NULL);
INSERT INTO progress_dirty SELECT utc_day,0 FROM (
  SELECT date(CAST(json_extract(data,'$.reviewedAt')/1000 AS INTEGER)-
    (json_extract(data,'$.reviewedAt')/1000.0<CAST(json_extract(data,'$.reviewedAt')/1000 AS INTEGER)),'unixepoch') utc_day FROM imported_reviews
  UNION SELECT date(CAST(reviewed_at/1000 AS INTEGER)-(reviewed_at/1000.0<CAST(reviewed_at/1000 AS INTEGER)),'unixepoch') FROM review_events
  UNION SELECT date(CAST(reviewed_at/1000 AS INTEGER)-(reviewed_at/1000.0<CAST(reviewed_at/1000 AS INTEGER)),'unixepoch') FROM practice_events
) WHERE utc_day IS NOT NULL;
CREATE TABLE progress_buckets (
  calendar TEXT NOT NULL, utc_day TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(calendar,utc_day)
);
CREATE TABLE progress_days (
  calendar TEXT NOT NULL, utc_day TEXT NOT NULL, study_date TEXT NOT NULL, answers INTEGER NOT NULL,
  PRIMARY KEY(calendar,utc_day,study_date)
);

CREATE TRIGGER progress_import_insert AFTER INSERT ON imported_reviews BEGIN
  UPDATE progress_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO progress_dirty SELECT utc_day,revision FROM progress_clock CROSS JOIN (
    SELECT date(CAST(json_extract(NEW.data,'$.reviewedAt')/1000 AS INTEGER)-
      (json_extract(NEW.data,'$.reviewedAt')/1000.0<CAST(json_extract(NEW.data,'$.reviewedAt')/1000 AS INTEGER)),'unixepoch') utc_day
  ) WHERE utc_day IS NOT NULL ON CONFLICT(utc_day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER progress_import_update AFTER UPDATE ON imported_reviews BEGIN
  UPDATE progress_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO progress_dirty SELECT utc_day,revision FROM progress_clock CROSS JOIN (
    SELECT date(CAST(json_extract(OLD.data,'$.reviewedAt')/1000 AS INTEGER)-
      (json_extract(OLD.data,'$.reviewedAt')/1000.0<CAST(json_extract(OLD.data,'$.reviewedAt')/1000 AS INTEGER)),'unixepoch') utc_day
    UNION SELECT date(CAST(json_extract(NEW.data,'$.reviewedAt')/1000 AS INTEGER)-
      (json_extract(NEW.data,'$.reviewedAt')/1000.0<CAST(json_extract(NEW.data,'$.reviewedAt')/1000 AS INTEGER)),'unixepoch')
  ) WHERE utc_day IS NOT NULL ON CONFLICT(utc_day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER progress_import_delete AFTER DELETE ON imported_reviews BEGIN
  UPDATE progress_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO progress_dirty SELECT utc_day,revision FROM progress_clock CROSS JOIN (
    SELECT date(CAST(json_extract(OLD.data,'$.reviewedAt')/1000 AS INTEGER)-
      (json_extract(OLD.data,'$.reviewedAt')/1000.0<CAST(json_extract(OLD.data,'$.reviewedAt')/1000 AS INTEGER)),'unixepoch') utc_day
  ) WHERE utc_day IS NOT NULL ON CONFLICT(utc_day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER progress_review_insert AFTER INSERT ON review_events BEGIN
  UPDATE progress_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO progress_dirty SELECT utc_day,revision FROM progress_clock CROSS JOIN (
    SELECT date(CAST(NEW.reviewed_at/1000 AS INTEGER)-(NEW.reviewed_at/1000.0<CAST(NEW.reviewed_at/1000 AS INTEGER)),'unixepoch') utc_day
  ) WHERE utc_day IS NOT NULL ON CONFLICT(utc_day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER progress_review_update AFTER UPDATE ON review_events BEGIN
  UPDATE progress_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO progress_dirty SELECT utc_day,revision FROM progress_clock CROSS JOIN (
    SELECT date(CAST(OLD.reviewed_at/1000 AS INTEGER)-(OLD.reviewed_at/1000.0<CAST(OLD.reviewed_at/1000 AS INTEGER)),'unixepoch') utc_day
    UNION SELECT date(CAST(NEW.reviewed_at/1000 AS INTEGER)-(NEW.reviewed_at/1000.0<CAST(NEW.reviewed_at/1000 AS INTEGER)),'unixepoch')
  ) WHERE utc_day IS NOT NULL ON CONFLICT(utc_day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER progress_review_delete AFTER DELETE ON review_events BEGIN
  UPDATE progress_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO progress_dirty SELECT utc_day,revision FROM progress_clock CROSS JOIN (
    SELECT date(CAST(OLD.reviewed_at/1000 AS INTEGER)-(OLD.reviewed_at/1000.0<CAST(OLD.reviewed_at/1000 AS INTEGER)),'unixepoch') utc_day
  ) WHERE utc_day IS NOT NULL ON CONFLICT(utc_day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER progress_practice_insert AFTER INSERT ON practice_events BEGIN
  UPDATE progress_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO progress_dirty SELECT utc_day,revision FROM progress_clock CROSS JOIN (
    SELECT date(CAST(NEW.reviewed_at/1000 AS INTEGER)-(NEW.reviewed_at/1000.0<CAST(NEW.reviewed_at/1000 AS INTEGER)),'unixepoch') utc_day
  ) WHERE utc_day IS NOT NULL ON CONFLICT(utc_day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER progress_practice_update AFTER UPDATE ON practice_events BEGIN
  UPDATE progress_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO progress_dirty SELECT utc_day,revision FROM progress_clock CROSS JOIN (
    SELECT date(CAST(OLD.reviewed_at/1000 AS INTEGER)-(OLD.reviewed_at/1000.0<CAST(OLD.reviewed_at/1000 AS INTEGER)),'unixepoch') utc_day
    UNION SELECT date(CAST(NEW.reviewed_at/1000 AS INTEGER)-(NEW.reviewed_at/1000.0<CAST(NEW.reviewed_at/1000 AS INTEGER)),'unixepoch')
  ) WHERE utc_day IS NOT NULL ON CONFLICT(utc_day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER progress_practice_delete AFTER DELETE ON practice_events BEGIN
  UPDATE progress_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO progress_dirty SELECT utc_day,revision FROM progress_clock CROSS JOIN (
    SELECT date(CAST(OLD.reviewed_at/1000 AS INTEGER)-(OLD.reviewed_at/1000.0<CAST(OLD.reviewed_at/1000 AS INTEGER)),'unixepoch') utc_day
  ) WHERE utc_day IS NOT NULL ON CONFLICT(utc_day) DO UPDATE SET revision=excluded.revision;
END;
