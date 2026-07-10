CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE sandboxes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  image TEXT NOT NULL,
  repository_url TEXT,
  initial_command_json TEXT NOT NULL,
  desired_state TEXT NOT NULL,
  container_id TEXT UNIQUE,
  state_volume TEXT NOT NULL UNIQUE,
  ssh_host_port INTEGER,
  ssh_host_public_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  last_error TEXT
);

CREATE INDEX idx_sandboxes_created_at ON sandboxes(created_at DESC);
CREATE INDEX idx_sandboxes_deleted_at ON sandboxes(deleted_at);
