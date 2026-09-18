# Public workflow reporting and moderation

This is the design record for the host control plane added by Tines/437.

Reports are private, exact-snapshot records. A browser submits a UUIDv4 intent, one explicit reason, and up to 1,000 Unicode code points of plain text. Domain-separated HMACs represent the trusted network address, optional signed-in account, and request ID. An atomic batch makes the idempotency request row the admission gate, applies both rolling quotas, advances one case version, and writes one report. Exact retries return one private receipt; different intents with equal text remain separate occurrences and consolidate only in moderator presentation.

Host authorization requires a configured stable user ID and a browser session at both route and service boundaries. Project membership, ownership, API keys, and run keys grant no moderation access. Inspection selects immutable stored public bytes by snapshot ID and never follows source provenance or loads private projects.

Owner state, host state, and publisher suspension are independent. Every dismiss, disable, restore, suspend, and unsuspend has a required reason and an immutable audit row. Status changes advance the relevant version in the same D1 batch as the audit gate. The existing final hosted-install receipt predicate remains the availability authority during races.

Cases use observed read and resolved cutoffs, so a simultaneous later report stays unread/open. Disable can resolve an observed cutoff but urgent removal without a report does not resolve unseen reports. Report count has no effect on availability.

Application retention is two hours for retry/rate pseudonyms, 90 days from first resolution for report content, and 365 days for audit. Active host/publisher reasons remain while their restriction is active. Bounded scheduled cleanup is isolated from scheduler/supervisor failures.
