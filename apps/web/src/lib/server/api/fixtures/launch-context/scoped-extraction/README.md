# Scoped extraction validation fixture

This package is synthetic evidence for the Distilling v3 / Applying v2 contract. It never authorizes edits to shared context. `manifest.json` freezes the four scope cases, source versions, review decisions, read conditions, and expected resolution. `lifecycle.json` defines the expected branch matrix; `apps/web/e2e/context-extraction.spec.ts` executes it on an isolated Worker/D1 and attaches the runtime receipt.

Reproduce the deterministic checks from the repository root:

```sh
pnpm --filter @tines/web exec vitest run src/lib/server/api/fixtures/launch-context/generate.test.ts
```

Each case has exact `before.md` and `after.md` source bytes plus a complete destination tree. Universal rules remain inline. Conditional procedures move to `skills/planning-procedures/SKILL.md`; update cases retain `notes/keep.txt`. The one-line discovery condition and path live in the manifest because the launch renderer authors that line.

The runtime receipts contain isolated item IDs and monotonically ordered operations. Sequence is the contract: destination write, complete destination read, exact effective-resolution and boundary checks, fresh-directory export, then source CAS. A needed consumer follows the stored read condition and reads the skill; an unrelated consumer reads only the prompt and verifies the universal rule remains inline. Proposed, rejected, unmentioned, invalid/missing/stale/changed destinations, wrong overrides, nonempty exports, material source conflicts, and interrupted resumes retain the exact source procedure until verification succeeds.
