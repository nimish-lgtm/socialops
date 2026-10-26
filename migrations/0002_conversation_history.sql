-- Short rolling chat history (last few turns) so the assistant can hold a conversation.
-- Cleared by "forget" and on erase.
ALTER TABLE conversations ADD COLUMN history jsonb NOT NULL DEFAULT '[]';
