# Context validation comparison

This fixture continues the single Tines/373 ledger: attempts 1–4 remain in `../effort-routine/observations.json`; this directory owns attempts 5 onward. The two cold pairs hold Codex 0.153.4, `gpt-6-astra`, high effort, task order, output contract, and five-minute cap fixed.

- Attempts 5/6 change only full history versus selected history plus the existing recovery recipe.
- Attempts 7/8 change only conditional procedure placement: inline versus the same-scope `planning-procedures` skill and one discovery line.

Each attempt has routine, conditional, and old-decision outputs in one invocation. Usage is aggregate and must not be allocated to a subcase. Acceptance is deterministic; a passing task-class result supports correctness, while efficiency by task class remains inconclusive.

Run a staged arm (this consumes an attempt and must not be used casually):

```sh
node comparison-fixtures/context-validation/run-attempt.mjs 5 comment-full
node comparison-fixtures/context-validation/check.mjs comparison-fixtures/context-validation/results/attempt-5/output.json
```

The driver rejects unknown arms, uses a fresh temporary directory, removes ambient Tines credentials, invokes a cold ephemeral Codex session with a 300-second timeout, and appends raw JSONL/stderr plus normalized output. `protocol.json` and the input SHA-256 values in `observations.json` must be frozen before invocation.
