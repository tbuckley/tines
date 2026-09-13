-- Stage stats and the events API's type + window filters scan `event` by type
-- inside a time range; (user_id, created_at) alone filters type after the read.
CREATE INDEX IF NOT EXISTS event_user_type_created_idx ON event (user_id, type, created_at DESC);
