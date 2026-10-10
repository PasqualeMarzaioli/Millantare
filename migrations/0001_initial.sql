-- 0001_initial.sql — Store the catalog and permanent delivery reservations.
-- Unique identities and an overlap trigger prevent reuse after edits or concurrent runs.
-- Author: Pasquale Marzaioli
CREATE TABLE words (
    language TEXT NOT NULL,
    lemma_key TEXT NOT NULL,
    example_key TEXT NOT NULL UNIQUE,
    register TEXT NOT NULL,
    message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4096),
    PRIMARY KEY (language, lemma_key)
);

CREATE TABLE readings (
    text_key TEXT PRIMARY KEY,
    language TEXT NOT NULL,
    original_language TEXT NOT NULL CHECK (original_language = language),
    work_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('poetry', 'prose')),
    range_start INTEGER NOT NULL CHECK (range_start >= 0),
    range_end INTEGER NOT NULL CHECK (range_end > range_start),
    text_length INTEGER NOT NULL,
    message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4096)
);
CREATE INDEX readings_language ON readings(language, kind, text_length);

CREATE TABLE deliveries (
    day TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'sent', 'uncertain', 'empty')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Reservations intentionally precede Telegram calls: uncertain sends must never retry.
CREATE TABLE used_words (
    language TEXT NOT NULL,
    lemma_key TEXT NOT NULL,
    example_key TEXT NOT NULL UNIQUE,
    day TEXT NOT NULL REFERENCES deliveries(day),
    PRIMARY KEY (language, lemma_key)
);

CREATE TABLE used_readings (
    text_key TEXT PRIMARY KEY,
    work_key TEXT NOT NULL,
    range_start INTEGER NOT NULL,
    range_end INTEGER NOT NULL,
    language TEXT NOT NULL,
    day TEXT NOT NULL REFERENCES deliveries(day)
);
CREATE INDEX used_readings_work ON used_readings(work_key, range_start, range_end);
CREATE TRIGGER prevent_overlapping_readings
BEFORE INSERT ON used_readings
WHEN EXISTS (
    SELECT 1 FROM used_readings
    WHERE work_key = NEW.work_key
      AND range_start < NEW.range_end AND range_end > NEW.range_start
)
BEGIN
    SELECT RAISE(ABORT, 'Reading overlaps a previous reservation');
END;

CREATE TABLE notices (
    notice_key TEXT PRIMARY KEY,
    day TEXT NOT NULL REFERENCES deliveries(day)
);

CREATE TABLE messages (
    day TEXT NOT NULL REFERENCES deliveries(day),
    position INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'attempted', 'sent')),
    telegram_message_id INTEGER,
    PRIMARY KEY (day, position)
);
