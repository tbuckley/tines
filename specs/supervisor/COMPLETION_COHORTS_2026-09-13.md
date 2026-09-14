# Completion-event cohorts (2026-09-13)

Completed-issue reporting is an explicit secondary Spend mode. It does not alter period usage grouping or issue lifetime accounting.

Membership comes only from retained `issue.created`, `issue.transitioned`, and workflow-changing `issue.updated` state-entry events. A workflow and exact terminal states define the cohort; omission means every current state whose actual category is `done`. The latest qualifying entry in the half-open window partitions each distinct issue. Present issue state and run outcome are not membership evidence.

Accounting includes all owned direct attempts created before the exclusive cutoff. Only attempts ended before that cutoff contribute finalized usage. Pending projections redact later outcome, end, provider, error, and usage facts. No-run issues remain in all-issue attempt and known-dollar means. Prices are recorded provider amounts or calculated list-cost estimates, not invoices.

The report signs resolved terminal proofs, period bounds, accounting cutoff, and reopening observation cutoff. Reopening means a later recorded non-done entry; incomplete later identity makes the result unknown. History and pricing coverage are independent disclosures. Cohort totals must never be presented as additive to period spend.
