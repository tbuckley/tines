# Effort routing decision (2026-09-13)

**Amended by:** [asserted effort for unlisted models](./ASSERTED_EFFORT_2026-09-22.md)

Effort is an optional exact-model setting, separate from the portable `smartest` / `balanced` / `cheapest` tier. A routing target may set it explicitly. A scoped `*:tier` target may set effort independently while inheriting runners. Resolution is routed effort, then the selected runner tier's effort, then provider default. Pins bypass routing but still receive runner-tier effort.

Local daemons report a bounded V1 exact-model capability catalog. Explicit routed effort is fail-closed when the final target cannot prove support, allowing ordered fallback to continue. During upgrade only, a legacy daemon may receive work with runner-tier effort configured; Tines deliberately omits the flag and records `legacy_not_applied`. An upgraded daemon must support the exact final model/value. Custom and unsupported managed harnesses never silently discard effort.

Runs snapshot requested effort, resolved effort, source, and application evidence at claim. Passing an argv flag is `accepted_unconfirmed`; it does not prove internal provider application. Managed provider configuration may be `confirmed` only from the returned configuration for the selected agent. Legacy records remain `unknown`, and provider-default launches remain unconfirmed.

Rollback is configuration-first: pause affected routes/runners, save target and tier JSON, remove routed effort and applicable local/Claude tier effort, inspect dispatch explanation, and settle active effort assignments before downgrading a worker. Keep additive columns and historical evidence.
