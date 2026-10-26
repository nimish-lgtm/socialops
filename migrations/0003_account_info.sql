-- Latest profile snapshot read from the platform's official API after connect (name, bio, followers, recent posts).
ALTER TABLE accounts ADD COLUMN info jsonb;
ALTER TABLE accounts ADD COLUMN info_at timestamptz;
