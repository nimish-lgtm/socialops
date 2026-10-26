-- Core schema. Every workspace-owned table carries workspace_id and is protected by row-level security.
-- Roles: the migration owner owns tables; socialops_app is subject to RLS; socialops_system has BYPASSRLS.

CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('personal','creator','business')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleting','deleted')),
  tz text NOT NULL DEFAULT 'Asia/Kolkata',
  ai_daily_cap_minor bigint,
  onboarded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  phone text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX members_ws ON members(workspace_id);

CREATE TABLE profiles (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '{}',
  step int NOT NULL DEFAULT 0,
  completed_at timestamptz
);

CREATE TABLE accounts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform text NOT NULL,
  surface text NOT NULL,
  account_type text NOT NULL,
  route text NOT NULL CHECK (route IN ('E','A','N')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','unhealthy','disconnected')),
  external_id text,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, external_id)
);

CREATE TABLE credentials (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  enc_blob text NOT NULL,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  last_checked_at timestamptz
);

CREATE TABLE inbound_events (
  wamid text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  from_hash text NOT NULL,
  kind text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_from_time ON inbound_events(from_hash, received_at);

CREATE TABLE conversations (
  phone text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'idle',
  context jsonb NOT NULL DEFAULT '{}',
  last_inbound_at timestamptz
);

CREATE TABLE outbound_messages (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  to_phone text NOT NULL,
  kind text NOT NULL,
  dedupe_key text UNIQUE,
  status text NOT NULL CHECK (status IN ('sending','sent','failed','unknown','blocked_window','delivered','read')),
  wa_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbound_wa_id ON outbound_messages(wa_id);

CREATE TABLE assets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  ref text NOT NULL,
  sha256 text NOT NULL,
  mime text,
  bytes bigint NOT NULL DEFAULT 0,
  qc jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow text NOT NULL,
  state text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 0,
  requested_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_ws_state ON tasks(workspace_id, state);

CREATE TABLE approvals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  summary text NOT NULL,
  payload_hash text NOT NULL,
  amount_minor bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','expired','superseded','used')),
  requested_from text,
  decided_by text,
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approvals_one_pending ON approvals(task_id) WHERE status = 'pending';

CREATE TABLE actions (
  idempotency_key text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  adapter text NOT NULL,
  op text NOT NULL,
  request jsonb NOT NULL,
  response jsonb,
  status text NOT NULL CHECK (status IN ('started','done','failed')),
  spend_minor bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE posts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  account_id text REFERENCES accounts(id) ON DELETE SET NULL,
  platform text NOT NULL,
  external_id text,
  url text,
  caption text NOT NULL,
  status text NOT NULL CHECK (status IN ('live','user_confirmed')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, account_id)
);

CREATE TABLE metric_snapshots (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_id text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  metrics jsonb NOT NULL,
  source text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_items (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('business','offer','audience','tone','banned_claim','language','fact','rule','person')),
  body text NOT NULL,
  source text NOT NULL CHECK (source IN ('owner_message','platform','inferred','external_untrusted')),
  consent text NOT NULL DEFAULT 'none' CHECK (consent IN ('none','explicit')),
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  answer text NOT NULL CHECK (answer IN ('none','others_ok','minors_or_unsure')),
  by_phone text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  item text NOT NULL,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_minor bigint,
  priced boolean NOT NULL,
  measured boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ws_time ON usage_events(workspace_id, created_at);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due ON jobs(status, run_at);

CREATE TABLE links (
  token_hash text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reconnect','export','media')),
  ref text NOT NULL,
  expires_at timestamptz NOT NULL,
  max_uses int NOT NULL DEFAULT 1,
  uses int NOT NULL DEFAULT 0
);

CREATE TABLE audit (
  id bigserial PRIMARY KEY,
  workspace_id text,
  actor text NOT NULL,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_ws ON audit(workspace_id, at);

-- Row-level security: enable + force on every workspace-owned table.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'workspace_id' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I USING (workspace_id = current_setting('app.workspace_id', true))
                   WITH CHECK (workspace_id = current_setting('app.workspace_id', true))$p$, t || '_tenant', t);
  END LOOP;
END $$;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_tenant ON workspaces USING (id = current_setting('app.workspace_id', true))
  WITH CHECK (id = current_setting('app.workspace_id', true));

-- Grants. The audit log is append-only for the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO socialops_app, socialops_system;
REVOKE UPDATE, DELETE ON audit FROM socialops_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO socialops_app, socialops_system;
