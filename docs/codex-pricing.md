# Codex run pricing

Tines records a Codex run's calculated cost as an **estimated Standard API list-price equivalent**. It is an auditable estimate of the token workload reported by Codex, not an OpenAI invoice, ChatGPT subscription consumption, or proof of the backend service tier.

## Sources and supported models

The append-only catalog is `apps/web/src/lib/server/supervisor/codex-pricing.ts`. Its four current flagship rows cite the [official Standard pricing page](https://developers.openai.com/api/docs/pricing); Codex-specific rows cite their exact official model page. The initial catalog was checked on 2026-09-11 and adopted at `2026-09-11T03:30:00Z`. Exact identities only are supported: gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5-codex, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.1-codex-mini, gpt-5.2-codex, gpt-5.3-codex, and codex-mini-latest.

Rates are selected by the run's immutable claim timestamp, not finish time. Add a new reviewed catalog version with a future adoption timestamp when a rate changes; never edit an adopted row. The persisted basis includes the exact rates, source, adoption/effective dates, normalized counters, and exact decimal result, so later catalog changes cannot reprice a run. Recheck the Sol promotion near 2026-11-21.

## Measurement and arithmetic

Codex JSONL reports cumulative thread totals. The daemon replaces, rather than adds, successive `turn.completed` snapshots and separates inclusive input into uncached input, cache reads, and cache writes. All four safe-integer dimensions must be present and non-overlapping. Tines calculates each class as `tokens × USD-per-million rate`, sums with scaled integers, divides by 1,000,000, and persists a canonical exact decimal; the existing numeric dollar field is only a compatibility projection. Display rounding never changes the stored basis.

Provider-reported dollars remain authoritative. Unsupported models, pre-adoption runs, missing/invalid dimensions, reroutes, multiple threads, unfinished later turns, and non-monotonic totals remain visibly Unpriced with a reason. For cold Codex 0.153.4 attempts, the daemon also reads the exact thread rollout after process close and reconciles advancing cumulative snapshots against their per-request deltas and the terminal total. It persists only the normalizer version, request count, largest inclusive request, and reconciled counters—not rollout content or paths. This proof permits the existing short rate when a multi-request thread total exceeds 272,000 but every request is at or below that boundary. Missing, unsupported, invalid, or known long/mixed request evidence remains explicitly Unpriced. Explicit measured zero is a valid priced result.

Codex resume is currently unsupported. If it is enabled later, cumulative thread totals require a validated baseline/delta protocol before resumed attempts can be priced. Cancellation or a sweep that wins the terminal compare-and-set before the daemon finish means later usage cannot be attached. Historical records are never reconstructed from logs or repriced.

## Rollout verification

Deploy the server/types/UI before upgrading daemons. The request normalizer is intentionally allowlisted to Codex `0.153.4`; a new shape or version stays unsupported until fixture-validated. Lookup is confined to the exact UUID thread file in date-bounded `CODEX_HOME/sessions` directories, with entry, file, line, request, and five-second limits. The producer first ships in CLI `0.0.1` (the release pipeline stamps the published patch version). A new daemon talking to an old server safely loses only the additive evidence; an old daemon talking to a new server remains token-only and Unpriced.

For rollout, finish one bounded supported Codex run for the deployed default and each exact override (currently Astra, Sol, and Luna), plus local unsupported/incomplete fixtures and a Claude provider report. Record run ID, daemon version, model, raw and normalized counters, rate ID/version, exact recomputation, API JSON, CLI output, and visible basis. Confirm historical null/token-only records did not change. Do not force a production reroute to manufacture an invalid case.
