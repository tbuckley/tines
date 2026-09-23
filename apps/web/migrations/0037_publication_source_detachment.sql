DROP TRIGGER IF EXISTS `workflow_publication_immutable_snapshot`;

CREATE TRIGGER `workflow_publication_immutable_snapshot`
BEFORE UPDATE OF `user_id`, `source_kind`, `source_provenance_json`, `document_json`, `document_digest`, `bytes_sha256`, `byte_length`, `metadata_json`, `review_digest`, `policy_version`, `created_at`, `published_at`, `snapshot_id`, `confirmed_at`, `confirmed_actor_key` ON `workflow_publication`
WHEN OLD.`published_at` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'published workflow snapshot content is immutable');
END;

-- A published snapshot owns its frozen bytes. The source workflow is only a
-- private convenience link, so its FK may detach that link on source deletion
-- without opening a way to retarget an immutable publication.
CREATE TRIGGER `workflow_publication_immutable_source`
BEFORE UPDATE OF `source_workflow_id` ON `workflow_publication`
WHEN OLD.`published_at` IS NOT NULL
	AND OLD.`source_workflow_id` IS NOT NEW.`source_workflow_id`
	AND NOT (OLD.`source_workflow_id` IS NOT NULL AND NEW.`source_workflow_id` IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'published workflow snapshot source is immutable');
END;
