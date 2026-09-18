# Launch-context comparison fixture

This synthetic package pins the pre-change renderer at commit
`cc738a1af95714f06fb53b5497ecaabeb8810dc9` and the current candidate. It contains no
tracker data or credentials. `input.json` fixes the clock, issue/provenance rows,
effective skill and files, artifacts, labels, and expected selected/omitted IDs.

Run the offline candidate/hash checker from the repository root:

```sh
pnpm --filter @tines/web exec vitest run src/lib/server/api/fixtures/launch-context/generate.test.ts
```

Regenerate candidate outputs and hashes after an intentional renderer change:

```sh
UPDATE_LAUNCH_CONTEXT_FIXTURES=1 pnpm --filter @tines/web exec vitest run src/lib/server/api/fixtures/launch-context/generate.test.ts
```

The `.before.md` files are frozen baseline outputs. The checker calls the real current
`buildLaunchPrompt` and `buildResumePrompt`; its explicitly labelled fixture-only transform
removes the new IDs/discovery presentation to reproduce the pinned baseline, never a second
production renderer. The comment-only pair holds legacy skill treatment constant, the
skill-only pair holds the complete comment thread constant, and the combined cold/resume
pairs show both changes.

Verify text counts with the pinned tokenizer:

```sh
python3 -m venv /tmp/tines-launch-context-tokens
/tmp/tines-launch-context-tokens/bin/pip install tiktoken==0.14.0
/tmp/tines-launch-context-tokens/bin/python apps/web/src/lib/server/api/fixtures/launch-context/measure.py
```

`measurements.json` reports opening bytes/tokens separately from the saved retrieval command,
success output, and missing-ID error. These are text measurements, not tool-call billing.
Whole-task consumption, model correctness, attempts, repairs, and causal savings are not
measured in Tines/520; Tines/521 owns those comparisons and the shared attempt ceiling.

The conditional skill files remain embedded unchanged in `input.json`. The prompt describes
only `skills/fixture-skill/SKILL.md`; its body and `support.txt` are deliberately absent from
all rendered Markdown and remain available through the effective context bundle.
