# Scoped extraction validation fixture

This package is synthetic evidence for the Distilling v3 / Applying v2 contract. It never authorizes edits to shared context. `manifest.json` freezes the four scope cases, source versions, review decisions, read conditions, and expected resolution. `lifecycle.json` is an ordered receipt ledger for destination-first application and every fail-safe branch.

Reproduce the deterministic checks from the repository root:

```sh
pnpm --filter @tines/web exec vitest run src/lib/server/api/fixtures/launch-context/generate.test.ts
```

Each case has exact `before.md` and `after.md` source bytes plus a complete destination tree. Universal rules remain inline. Conditional procedures move to `skills/planning-procedures/SKILL.md`; update cases retain `notes/keep.txt`. The one-line discovery condition and path live in the manifest because the launch renderer authors that line.

The lifecycle receipts use stable aliases instead of production IDs. Sequence is the contract: destination write, complete destination read, effective-resolution check, fresh-directory export, then source CAS. Rejected, unmentioned, invalid/missing/stale destinations, wrong overrides, nonempty exports, material source conflicts, and interrupted resumes all retain the source until verification succeeds.
