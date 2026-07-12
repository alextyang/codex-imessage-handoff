ALTER TABLE handoff_threads ADD COLUMN project_label TEXT;
ALTER TABLE handoff_threads ADD COLUMN catalog_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE handoff_threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE handoff_threads ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE handoff_threads ADD COLUMN last_seen_at TEXT;

CREATE TABLE IF NOT EXISTS service_installations (
  owner_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  service_version TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  delivery_mode TEXT NOT NULL DEFAULT 'service',
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS installation_pairings (
  owner_id TEXT PRIMARY KEY,
  pairing_code TEXT UNIQUE,
  pairing_code_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_snapshots (
  phone_number TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  items_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS handoff_threads_catalog_idx
  ON handoff_threads(owner_id, visible, archived, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS installation_pairings_code_idx
  ON installation_pairings(pairing_code);
