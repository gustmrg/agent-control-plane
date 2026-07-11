ALTER TABLE sandboxes ADD COLUMN profile_name TEXT;
ALTER TABLE sandboxes ADD COLUMN profile_version INTEGER;

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  backend TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE local_secret_values (
  secret_name TEXT PRIMARY KEY REFERENCES secrets(name) ON DELETE CASCADE,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  auth_tag BLOB NOT NULL
);

CREATE TABLE agent_profiles (
  name TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE agent_profile_versions (
  profile_name TEXT NOT NULL REFERENCES agent_profiles(name),
  version INTEGER NOT NULL,
  bundle_ciphertext BLOB NOT NULL,
  bundle_nonce BLOB NOT NULL,
  bundle_auth_tag BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_name, version)
);

CREATE TABLE profile_secret_refs (
  profile_name TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  secret_name TEXT NOT NULL REFERENCES secrets(name),
  PRIMARY KEY (profile_name, profile_version, secret_name),
  FOREIGN KEY (profile_name, profile_version)
    REFERENCES agent_profile_versions(profile_name, version)
);

CREATE TABLE agent_profile_defaults (
  agent TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL REFERENCES agent_profiles(name)
);

CREATE TABLE secret_leases (
  secret_name TEXT PRIMARY KEY REFERENCES secrets(name),
  sandbox_id TEXT NOT NULL UNIQUE REFERENCES sandboxes(id),
  secret_version INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);

CREATE INDEX idx_profiles_agent ON agent_profiles(agent, deleted_at);
CREATE INDEX idx_profile_refs_secret ON profile_secret_refs(secret_name);
CREATE INDEX idx_secret_leases_sandbox ON secret_leases(sandbox_id);
