-- Tines/751: the project_member revision a member-contributor run was admitted
-- under. NULL for owner runs; a member run with NULL is never bound.
ALTER TABLE agent_run ADD COLUMN admitted_membership_revision INTEGER;
