-- Browser chat transcript (the web channel's equivalent of the WhatsApp app). Keyed by the session's phone id.
CREATE TABLE webchat_messages (
  id bigserial PRIMARY KEY,
  phone text NOT NULL,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  dir text NOT NULL CHECK (dir IN ('in','out')),
  body jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webchat_phone ON webchat_messages(phone, id);

-- Public profile data looked up from a link the user shared, via official APIs only.
CREATE TABLE page_lookups (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform text NOT NULL,
  handle text NOT NULL,
  url text NOT NULL,
  info jsonb NOT NULL,
  looked_up_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webchat_messages','page_lookups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I USING (workspace_id = current_setting('app.workspace_id', true))
                   WITH CHECK (workspace_id = current_setting('app.workspace_id', true))$p$, t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON webchat_messages, page_lookups TO socialops_app, socialops_system;
GRANT USAGE, SELECT ON SEQUENCE webchat_messages_id_seq TO socialops_app, socialops_system;
