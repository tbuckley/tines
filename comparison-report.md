# Comparison and adoption report

Decision: adopt selected launch-comment presentation on the narrow observed basis that all task classes preserved correctness while aggregate input fell; retain scoped skills for conditional-procedure delivery because the extraction contract and retrieval worked, but treat their efficiency as inconclusive. Do not change production effort defaults.

## Frozen protocol and complete ledger

Attempts 1–4 are preserved unchanged in `comparison-fixtures/effort-routine/observations.json`. Attempts 5–8 and raw evidence are in `comparison-fixtures/context-validation/`; four of twelve attempts remain unused. Every new invocation was cold, used Codex CLI 0.153.4, `gpt-6-astra`, high effort, one compound routine/conditional/old-decision task, and finished below the five-minute cap. No Claude retry or resumed model trial occurred.

| # | Pair / arm | Acceptance | Elapsed | Input | Cache read | Uncached input | Output | Reasoning |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | unavailable Codex model | fail: unavailable | 1 s | null | null | null | null | null |
| 2 | effort / high | pass | 12 s | 66,155 | 56,192 | 9,963 | 306 | 0 |
| 3 | effort / low | pass | 15 s | 66,070 | 51,968 | 14,102 | 296 | 0 |
| 4 | Claude | fail: authentication | 0.04 s | null | null | null | null | null |
| 5 | comments / full | all 3 pass | ~67 s | 211,499 | 200,448 | 11,051 | 2,156 | 325 |
| 6 | comments / selected | all 3 pass | 74.592 s | 110,801 | 101,888 | 8,913 | 1,980 | 306 |
| 7 | procedure / inline | all 3 pass | 80.674 s | 142,670 | 114,304 | 28,366 | 2,039 | 392 |
| 8 | procedure / skill | all 3 pass | 96.58 s | 216,285 | 191,616 | 24,669 | 2,425 | 575 |

Provider totals include the whole invocation through the model's own output validation. Cache-write is reported as zero for attempts 5–8. Acceptance-check wall time outside the invocation was below one second. Attempt 5's model call and evidence completed, but the run-receipt writer referenced a misspelled variable after saving raw JSONL and output; that deterministic repair was committed before attempt 6 and did not trigger another call. Its elapsed time is reconstructed and marked approximate. Null means unknown.

Opening text size and whole-task consumption are separate. The frozen inputs and SHA-256 hashes are recorded in each attempt receipt (except the documented attempt-5 postprocess failure), and the accepted `/520` full/selected snapshots remain produced by the real builder. Cache differences, single-pair samples, compound-task carryover, and model nondeterminism are confounders. No weekly-quota conversion is claimed.

## Decisions by task class

| Change | Task class | Codex decision | Basis |
| --- | --- | --- | --- |
| Comment trimming | routine | adopt narrowly | Correct; selected arm retained universal rules and unknown fields without skill retrieval. |
| Comment trimming | conditional | adopt narrowly | Correct; selected arm read the same procedure and preserved inspection, fresh attachment, Re-propose, Root provenance, and no self-approval. |
| Comment trimming | long history | adopt narrowly | Correct; old human decision remained inline and `cmt_old_detail` was recovered with the existing JSON/jq recipe. |
| Inline → skill | routine | inconclusive efficiency | Correct and did not need procedure content, but only aggregate accounting is available. |
| Inline → skill | conditional | inconclusive efficiency | Correct retrieval and adherence; the skill arm used more aggregate input/output and time, while uncached input was lower. |
| Inline → skill | long history | inconclusive efficiency | Correct in both arms; placement was unrelated to history and compound usage cannot be allocated. |
| High → low effort | routine | inconclusive | Prior pair preserved correctness but had mixed cache/accounting and no repetition. |
| High → low effort | conditional / long | not trialed | Remaining allowance was prioritized for the missing comment/skill validation. |

Claude remains unavailable because the prior authentication/accounting stop prohibits credential workarounds or retries. Resumed trials remain excluded because `/452` and `/426` prerequisites are unmet.

## Extraction evidence

`apps/web/src/lib/server/api/fixtures/launch-context/scoped-extraction/` contains global, project, Root-state, and combined project/Root cases. Every case freezes exact before/after inline bytes, complete skill files, source/destination versions and scopes, proposal disposition, one-line read condition/path, needed/unneeded tasks, and the effective winner. Update cases retain unrelated files. The separate override matrix pins global → project → state → combined rank, base inheritance, and the combined-base-over-state-leaf rule.

`lifecycle.json` records destination write/read/effective resolution/fresh export before source CAS. Proposed, rejected, unmentioned, invalid/missing/stale destinations, wrong overrides, nonempty exports, material source conflicts, interrupted resumes, changed resumes, and idempotent replay have explicit source-retention outcomes. These are synthetic isolated-stack fixtures, not authorization to migrate shared context. The real-builder test checks the package and ordering invariants; independent review must inspect the exact bodies and receipts, not infer acceptance from a green suite alone.

## Reproduction and rollback

```sh
pnpm --filter @tines/web exec vitest run src/lib/server/api/fixtures/launch-context/generate.test.ts src/lib/server/api/context.test.ts src/lib/server/api/context-inheritance.test.ts
node comparison-fixtures/context-validation/check.mjs comparison-fixtures/context-validation/results/attempt-8/output.json
```

Do not rerun model attempts merely to improve results; ledger numbers 9–12 are unused reserve, not a fresh allowance. To roll back a failed extraction, restore the exact inline source before removing a verified destination. For a comment regression, restore the prior presentation while retaining stored full history. Historical effort rollback remains configuration-first: remove routed effort, clear tier effort if required, and leave additive evidence intact. No fixture changed production configuration or defaults.
