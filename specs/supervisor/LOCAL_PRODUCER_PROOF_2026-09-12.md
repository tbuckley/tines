# Local producer proof — 2026-09-12

Status: accepted producer-boundary amendment to
[Codex pricing](CODEX_PRICING_2026-09-11.md).

Codex's terminal token total is cumulative across a thread, so it cannot identify an
individual request's context band. Codex CLI 0.153.4 rollouts provide cumulative and last-request
four-class snapshots. For a cold, completed attempt, the daemon may therefore prove short-band
eligibility by reading only the exact provider thread's rollout and accepting it when:

- session metadata is `exec` / `codex_exec`, the version is exactly 0.153.4, and every observed
  model agrees with the immutable launch model;
- every advancing cumulative snapshot is component-wise nondecreasing, its delta equals the
  provider's last-request snapshot, and cache classes do not exceed inclusive input;
- the final cumulative snapshot exactly equals the renderer's terminal usage; and
- every request delta is at most 272,000 inclusive input tokens.

Repeated identical cumulative snapshots are deduplicated. Missing, mixed, malformed,
nonmonotonic, changed-during-read, resumed, failed, unsupported-version, or over-limit evidence
fails closed with a recorded reason. Collection is restricted to the exact UUID thread and a
bounded date window, entry count, file size, line size, line count, request count, and five-second
streaming deadline. No transcript text is persisted or sent.

This proof is additive only for catalog rows whose context band is `short`: it permits their
existing rates when cumulative usage exceeds the legacy guard and every reconciled request is
short. It does not alter rate values, the append-only catalog, calculation/basis versions, CAS
semantics, or `published` rows. Known long/mixed requests remain unpriced as
`long_context_rate_unsupported`; absent proof remains `long_context_band_unknown`; invalid proof
is `request_context_invalid`.

Claude Code remains provider-authoritative: its terminal result supplies tokens and dollars.
The sampled null-usage runs were produced by a stale source-launched daemon predating summary
capture, so correction is an idle-safe replacement with the managed-prefix daemon, not a parser
change. Publication, running-daemon adoption, and fresh-run verification are separate facts.
