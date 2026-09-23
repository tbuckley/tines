# Public workflow moderation operations

Public publishing remains off until an operator records a named primary reviewer and backup, confirms a daily queue check, configures the appeal contact, verifies retention across application and infrastructure storage, and completes the isolated publish → report → moderate → unavailable journey. `PUBLIC_WORKFLOW_MODERATION_QUEUE_READY` and `PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED` are attestations of completed work, not substitutes for it.

## Daily queue

1. Sign in as a user whose stable ID is in `PUBLIC_WORKFLOW_MODERATOR_USER_IDS`; API keys and run keys never have host authority.
2. Open `/host/workflow-reports` and check Unread, then Open. Inspect only the immutable stored public snapshot shown there; moderation does not grant access to its source project.
3. Dismiss reports that need no availability change. Disable an exact snapshot for snapshot-specific harm. Suspend a publisher only when new publishing and every hosted snapshot must stop.
4. Write a contextual reason. Disable and suspension reasons are shown to the publisher, so exclude reporter details and internal identifiers.
5. Handle appeals at `PUBLIC_WORKFLOW_APPEAL_CONTACT`. An appeal never restores content automatically. Verify owner, host, and publisher states before restoring or unsuspending.

Urgent removal accepts an exact `/p/<snapshot>` URL or snapshot ID even when no report exists. Report volume never hides content automatically.

## Privacy and retention

- Network and signed-in account quota subjects are immediately HMAC-SHA-256 pseudonyms and expire after two hours. Raw addresses and reporter account IDs are not stored in report records or shown to moderators or publishers.
- Unresolved reports remain until a decision. Each resolved report and its reason/note/receipt is deleted 90 days after its first resolution.
- Private moderation audit records expire after 365 days. A current removal or suspension reason remains in the active status record while that restriction remains active.
- Cleanup runs from the five-minute scheduled handler in bounded batches and opportunistically on report traffic. After an outage, keep firing the scheduled handler until the backlog drains. Verify platform logs and backups have an acceptable independent retention policy before launch.
- Rotating `PUBLIC_WORKFLOW_REPORT_HMAC_SECRET` resets quota and retry correlation. Use a dedicated secret of at least 32 random bytes and treat rotation as an incident operation.

## Recovery and limits

Disable and suspension take effect at the next host authority check and fence stale install plans at their final receipt write. Restore and unsuspend increment versions again. Unsuspension never restores an owner-withdrawn or host-removed snapshot; only a host moderator can restore a host removal.

Tines cannot recall bytes already displayed or downloaded or an independently completed installation. Do not describe moderation as a safety certification or legal-compliance review. Troubleshoot denied access by checking session authentication and the configured stable user ID; never grant moderator authority to a key.
