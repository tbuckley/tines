-- Explicit, inspectable API-key authority. The full-policy default preserves
-- existing keys and inserts from the worker version deployed before this
-- additive migration; the new worker always writes an explicit policy.
ALTER TABLE `api_key` ADD COLUMN `permissions` TEXT NOT NULL
	DEFAULT '{"version":1,"projects":{"access":"delete","scope":"all"},"workspace":"delete","control_plane":"delete"}';
