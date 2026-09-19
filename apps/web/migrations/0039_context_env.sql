-- Env context items (Tines/597): the variable value lives in columns, not
-- `config`, because publication snapshots and library exporters copy
-- `config` wholesale. Exactly one of env_value / env_value_enc is set;
-- env_value_enc is AES-GCM ciphertext under SECRET_ENCRYPTION_KEY.
ALTER TABLE context_item ADD COLUMN env_value TEXT;
ALTER TABLE context_item ADD COLUMN env_value_enc TEXT;
ALTER TABLE context_item ADD COLUMN env_hint TEXT;
