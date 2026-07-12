ALTER TABLE handoff_threads ADD COLUMN project_key TEXT;
ALTER TABLE handoff_threads ADD COLUMN activity_at TEXT;
ALTER TABLE handoff_threads ADD COLUMN state_since TEXT;
ALTER TABLE handoff_threads ADD COLUMN reasoning_effort TEXT;
ALTER TABLE handoff_threads ADD COLUMN catalog_generation TEXT;

CREATE INDEX IF NOT EXISTS handoff_threads_directory_idx
  ON handoff_threads(owner_id, visible, archived, project_key, activity_at);
