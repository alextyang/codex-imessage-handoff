-- Presentation metadata used to keep deterministic identities and useful
-- directory rows stable when the relay renders a local catalog snapshot.
ALTER TABLE handoff_threads ADD COLUMN catalog_created_at_explicit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE handoff_threads ADD COLUMN project_started_at TEXT;
ALTER TABLE handoff_threads ADD COLUMN turn_count INTEGER;
ALTER TABLE handoff_threads ADD COLUMN turn_count_lower_bound INTEGER NOT NULL DEFAULT 0;
