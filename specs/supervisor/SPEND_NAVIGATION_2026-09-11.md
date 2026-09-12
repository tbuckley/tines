# Agents Spend navigation (2026-09-11)

This decision narrows the broader supervisor budget design to the shipped period statement under **Agents → Spend**.

- `$app/state.page.url` is the committed source of truth. Tabs and controls use ordinary SvelteKit navigation, preserve unrelated query parameters, the hash, and page state, and compose rapid pending changes. Canonical defaults are written only after router readiness.
- Spend project is explicit and independent from global focus after entry. Project changes reset workflow narrowing; window and grouping changes preserve it. Sort is client-only and Unknown remains last in both directions.
- Custom bounds are drafts until Apply. Both are required, To is exclusive, and browser history restores applied values. An incomplete selection has a correction state and neither a spinner nor an old report.
- Each population request captures an immutable selection and generation. A newer selection or unmount invalidates it, and a 30-second deadline ends loading. Only same-selection Refresh failures retain a report, with its original scope and bounds.
- No runs, pending-only, unreported, token-only/unpriced, measured zero, partial pricing, and complete pricing are distinct states. Provider amounts and calculated list costs are not invoices or subscription allowances. Budgets are not enforced by this view.

See [period usage](../../docs/usage.md) for the accounting and reconciliation contract. Detailed run drill-down, lifetime/cohort reporting, historical backfill, pricing policy, and budget enforcement remain outside this decision.
