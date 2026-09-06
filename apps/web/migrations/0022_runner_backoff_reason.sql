-- Why a runner is backing off. 'rate_limit' = its harness's account hit a usage
-- limit and backoff_until is the reported reset (clamped); NULL = the ordinary
-- consecutive-failure backoff, which is every runner predating this column.
ALTER TABLE runner ADD COLUMN backoff_reason TEXT;
