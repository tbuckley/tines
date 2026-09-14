# Comparison and adoption report

Decision: reject adoption from these trials. Content correctness is unknown because no independent semantic review is attached; the automated checker now reports only transport validity and cannot accept prose. Separately, the selected-history arm did not execute omitted-comment recovery and both skill-reading candidates violated the mandatory routine-before-skill order. Skill efficiency and comment-trimming efficiency remain inconclusive. Do not change production effort defaults.

## Frozen protocol and complete ledger

Attempts 1–4 are preserved unchanged in `comparison-fixtures/effort-routine/observations.json`. Attempts 5–8 and raw evidence are in `comparison-fixtures/context-validation/`; four of twelve attempts remain unused. Every new invocation was cold, used Codex CLI 0.153.4, `gpt-6-astra`, high effort, one compound routine/conditional/old-decision task, and finished below the five-minute cap. No Claude retry or resumed model trial occurred.

| # | Pair / arm | Acceptance | Elapsed | Input | Cache read | Uncached input | Output | Reasoning |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | unavailable Codex model | fail: unavailable | 1 s | null | null | null | null | null |
| 2 | effort / high | pass | 12 s | 66,155 | 56,192 | 9,963 | 306 | 0 |
| 3 | effort / low | pass | 15 s | 66,070 | 51,968 | 14,102 | 296 | 0 |
| 4 | Claude | fail: authentication | 0.04 s | null | null | null | null | null |
| 5 | comments / full | content unknown; ordering fail | null | 211,499 | 200,448 | 11,051 | 2,156 | 325 |
| 6 | comments / selected | content unknown; recovery and ordering fail | 74.592 s | 110,801 | 101,888 | 8,913 | 1,980 | 306 |
| 7 | procedure / inline | content unknown | 80.674 s | 142,670 | 114,304 | 28,366 | 2,039 | 392 |
| 8 | procedure / skill | content unknown; ordering fail | 96.58 s | 216,285 | 191,616 | 24,669 | 2,425 | 575 |

Provider totals include the whole invocation through the model's own output validation. Cache-write is reported as zero for attempts 5–8. Acceptance-check wall time outside the invocation was below one second. Attempt 5's model call saved raw JSONL and output, but the receipt writer failed; start, end, elapsed and input hashes are therefore null rather than reconstructed. Null means unknown.

Opening text size and whole-task consumption are separate. The frozen inputs and SHA-256 hashes are recorded in each attempt receipt (except the documented attempt-5 postprocess failure), and the accepted `/520` full/selected snapshots remain produced by the real builder. Cache differences, single-pair samples, compound-task carryover, and model nondeterminism are confounders. No weekly-quota conversion is claimed.

## Decisions by task class

| Change | Task class | Codex decision | Basis |
| --- | --- | --- | --- |
| Comment trimming | routine | reject observed candidate | Attempt 6 read the skill before its trace finalized routine; the mandatory ordering check failed. |
| Comment trimming | conditional | inconclusive | Content correctness is unknown and the arm failed mandatory ordering. Aggregate savings cannot rescue it. |
| Comment trimming | long history | reject observed candidate | No recovery request occurred. The answer repeated a body and command supplied inline, so omitted-comment recovery is unobserved. |
| Inline → skill | routine | reject observed candidate | Attempt 8 read the skill before its trace finalized routine. |
| Inline → skill | conditional | inconclusive efficiency | Content correctness is unknown, mandatory ordering failed, and aggregate/cache results conflict. |
| Inline → skill | long history | inconclusive | Placement was unrelated to history and compound usage cannot be allocated. |
| High → low effort | routine | inconclusive | Prior pair preserved correctness but had mixed cache/accounting and no repetition. |
| High → low effort | conditional / long | not trialed | Remaining allowance was prioritized for the missing comment/skill validation. |

Claude remains unavailable because the prior authentication/accounting stop prohibits credential workarounds or retries. Resumed trials remain excluded because `/452` and `/426` prerequisites are unmet.

## Extraction evidence

`apps/web/src/lib/server/api/fixtures/launch-context/scoped-extraction/` contains global, project, Root-state, and combined project/Root source packages. `apps/web/e2e/context-extraction.spec.ts` now executes those packages against a fresh Worker/D1: it creates the real scopes, uses the CLI for file-preserving skill updates and exports, resolves inherited effective context, records needed/no-read traces, and performs source CAS only after verification.

The Playwright attachment `scoped-extraction-receipts.json` is the runtime record: separate per-scope item IDs, versions, exact scope tuples, inheritance provenance, exported paths, failure statuses and source bodies in monotonic operation order. Distinct per-scope consumers execute the needed task by reading the exported prompt and skill in order; the unrelated consumer reads only `prompt.md` and verifies the universal rule remains inline. Runtime branches cover proposed, rejected and unmentioned review states; invalid, missing, stale and changed destinations; interrupted duplication; nonempty exports; wrong overrides; material source conflicts; re-verification; and replay without a version bump. Every pre-application stop asserts the exact before-body remains at the source. These isolated fixtures are not authorization to migrate shared context.

## Reproduction and rollback

```sh
pnpm --filter @tines/web exec vitest run src/lib/server/api/fixtures/launch-context/generate.test.ts src/lib/server/api/context.test.ts src/lib/server/api/context-inheritance.test.ts
node comparison-fixtures/context-validation/check.mjs comparison-fixtures/context-validation/results/attempt-8/output.json
node comparison-fixtures/context-validation/check.mjs --self-test
```

Do not make more model calls: the mandatory-instruction stop rule fired with attempts 1–8 spent. The repaired harness withholds the old body, pins a fixture-only key to a loopback issue server, and records recovery requests for any future authorized run. To roll back a failed extraction, restore the exact inline source before removing a verified destination. For a comment regression, restore the prior presentation while retaining stored full history. Historical effort rollback remains configuration-first. No fixture changed production configuration or defaults.
