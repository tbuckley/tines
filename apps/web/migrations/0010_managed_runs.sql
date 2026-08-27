-- Managed-runner provider bookkeeping (Milestone 2, Claude managed runs).
-- `provider_meta` is a small JSON bag owned by the run's adapter: the
-- per-run vault id (the agent's TINES_API_KEY credential lives there until
-- the run's provider resources are garbage-collected), the event-poll
-- cursor, and the GC marker. Never serialized into API responses.

ALTER TABLE `agent_run` ADD COLUMN `provider_meta` TEXT;
