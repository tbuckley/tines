# Automated review — round 1 (Tines/9, PR 62 @ `3060b8f`)

**Verdict: fail — 2 blocking findings.** The implementation itself is good: the helper is
correct and genuinely well tested (4/4 mutations caught), all five call sites are wired and
verified end-to-end, and the `--help` regression guard has teeth. What fails is coverage the
implementer did not run — a stale e2e assertion that this change breaks — plus a rollout
hazard the design reasoned about correctly for one artefact and then did not apply to
another.

Branch is a descendant of `origin/main` (`14fdc0d`); `gh pr view` reports `MERGEABLE` /
`CLEAN`.

## Blocking

### B1 — `apps/web/e2e/context.spec.ts:263` is stale and fails on this branch

The spec still asserts the prompt copy this PR replaces:

```ts
expect(prompt.text).toContain(`Add a comment: \`tines issues comment ${projectName}/1 "<markdown>"\``);
```

Run on the branch (`E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/context.spec.ts`):

```
1 failed
  e2e/context.spec.ts:255:2 › builds the launch prompt: context first, issue block last
2 did not run
11 passed
```

The describe is serial, so the abort also skips two later tests. This is unambiguously
introduced by the PR: the expected substring is `origin/main`'s rendered text verbatim, and
the received string in the failure output is the new heredoc block.

It was missed because `pnpm check` + `pnpm test` — the gates the PR body cites — do not
cover Playwright. `CLAUDE.md` says this explicitly: *"`apps/web/e2e/` — the Playwright
suite, which CI never runs. A green `pnpm test` says nothing about it, so run it yourself
before claiming end-to-end behaviour."*

**Fix:** one line. I patched it locally to
`` expect(prompt.text).toContain(`tines issues comment ${projectName}/1 - <<'EOF'`) `` and
re-ran: **14/14 passed**. Please also run `pnpm test:e2e` once before handing back.

Note `context.spec.ts:482` (`tines journal append … "- <date>: <lesson>"`) still passes —
the journal line keeps its inline form, so only the comment assertion is affected.

### B2 — the new prompt copy silently corrupts comments on any runner with a pre-PR CLI

The prompt-copy change deploys the moment this merges. The CLI reaches `local` runners only
when a human reinstalls it. Between those two events, an agent that follows the prompt
destroys its own report.

Demonstrated, not inferred. Against a local mock API, using the *exact* command the new
prompt teaches, with the CLI currently installed on this runner (0.0.1, i.e. pre-PR):

```
$ tines issues comment Tines/1 - <<'EOF'
Progress report with `backticks` and $VARS.
Second paragraph.
EOF
commented on Tines/#1 as ...        # exit 0
--- server received ---
COMMENT BODY SENT >>>-<<<
```

Exit 0, a success message, and a comment whose entire body is the single character `-`. The
report is gone and there is no comment-delete affordance — the precise irreversibility this
issue was filed to fix. The `@file` form fails the same way (posts the literal string
`@/tmp/b.md`). The PR CLI handles both correctly, so the fault is purely the version skew.

The exposure is real on this deployment, not theoretical:

- `tines --version` on this runner (macbook-claude) → **0.0.1**, and its `dist` still
  contains `body: markdown`.
- `packages/cli/src/daemon/` contains no `npm` reference anywhere — the daemon never
  updates the CLI.
- Only the `claude_managed` preamble variant tells the agent to `npm i -g tines`
  (`preamble.ts:57`). The `local` variant — this one — says *"The `tines` CLI is installed
  on this machine"* and offers no version guidance.
- npm has 0.0.77 (published today), so publishing works; the gap is purely that existing
  installs never refresh.

The design saw this rule and applied it — to the *other* artefact. It filed Tines/69 for the
live `agent-guidelines` item and blocked it on this issue, reasoning *"the live prompt must
not teach a form the released CLI rejects."* The `context.ts` strings need the same gate and
did not get one, and there the failure is worse than a rejection: it is silent. The design's
stated mitigation — *"until it picks up the new version, agents fall back to the inline
form, which still works"* — does not hold. There is no fallback: the command succeeds, so
nothing prompts the agent to try anything else. The PR also removes the inline form from the
prompt entirely and asserts its absence (`context.test.ts:263`,
`expect(block).not.toContain(...)`).

**This one needs a decision, and I am flagging it rather than prescribing.** Options, in my
order of preference:

1. **Split the prompt-copy change out** into a follow-up that lands after the `local`
   runner's CLI is updated — exactly the treatment Tines/69 already gets, applied
   consistently. The CLI half of this PR is independently valuable and ships safely today.
2. **Keep both forms in the prompt**: inline as the default, heredoc offered for bodies that
   need it. Degrades to correct behaviour on an old CLI.
3. **Add a version hint** to the copy (`needs tines ≥ <version>; check with tines --version`).
   Cheapest, but relies on the agent actually checking.

If the human prefers to merge as-is and simply update the runner's CLI at release time,
that is a legitimate call — but it should be a deliberate one, and the design's justification
for it is factually wrong as written.

## Non-blocking

### N1 — every call site this PR adds is unpinned; only the helper is tested

The helper is genuinely well covered. Four mutations of `body-value.ts`, each applied,
grep-verified, run, and restored:

| mutation | result |
|---|---|
| `value === '-'` → `value.startsWith('-')` | 2 failed / 47 passed |
| TTY guard removed | 1 failed / 48 passed |
| empty-stdin check removed | 1 failed / 48 passed |
| `@@` check moved after the `@` branch | 2 failed / 47 passed |

The wiring is not. Reverting each call site to its pre-PR body — i.e. reintroducing exactly
the bug this issue was filed for — leaves **49/49 green** every time:

| mutation (`index.ts`) | result |
|---|---|
| W1 `issues comment`: `const body = markdown` | 49/49 passed |
| W2 `journal append`: `const text = markdown` | 49/49 passed |
| W3 create-race path re-reads the body (double stdin consumption — the exact bug the design's "resolve once" note guards against) | 49/49 passed |
| W4 `issues create -d` passes `opts.description` raw | 49/49 passed |
| W5 `helpGuard()` removed from `issues comment` | **1 failed** ✅ |

W5 failing is the good news: the new spawn test in `help-output.test.ts:58` bites, and it
bites in the right way — the harness rejects because the command exited non-zero trying to
POST to the unreachable URL, which is a stronger signal than a stdout match.

This is the standing `packages/cli` gap (no HTTP-mock harness), so it is a structural note,
not implementer sloppiness. But there is a cheap fix here that needs no mock at all: for
`issues comment` and `journal append` the body resolves *before* any network call, so a
missing `@file` fails locally. Verified:

```
$ TINES_API_URL=http://127.0.0.1:1 tines issues comment Tines/1 @/tmp/nope.md
error: cannot read /tmp/nope.md: ENOENT: ...        # exit 1
$ TINES_API_URL=http://127.0.0.1:1 tines journal append Tines/1 @/tmp/nope.md
error: cannot read /tmp/nope.md: ENOENT: ...        # exit 1
```

~10 lines in the existing `help-output.test.ts` spawn harness would pin both call sites and
kill W1 and W2. Worth doing while the file is open; not a reason to hold the PR on its own.

### N2 — the three `-d` sites resolve the body after the lookup, not before

`issues create` (`index.ts:1061`), `issues edit` (`:1108`) and `schedules edit` (`:2251`)
call `readBodyValue()` inside the request-body expression, so a missing `@file` is reported
only after the project/issue/schedule lookup round-trips. Not a correctness bug — nothing is
written before the read, verified against a live schedule:

```
$ tines schedules edit "Tines/QA run" -d @/tmp/nope.md
error: cannot read /tmp/nope.md: ENOENT: ...        # exit 1, no write
```

`comment` and `append` resolve first, which is the better shape. Cosmetic.

### N3 — `AGENT_GUIDELINES_BODY` list is loose (implementer already flagged this)

Rendered and inspected: the fenced block nests correctly, but there is no blank line before
the next bullet, so CommonMark renders the whole list loose (`<p>` per item). Invisible in
the prompt, which is consumed as plain text. A blank line after the closing fence fixes it
if the web rendering matters.

### N4 — `specs/` still shows the old copy; correctly left alone

`specs/context/AGENT_EDITING.md:412` and `specs/context/SPEC.md:123,130` still quote
`tines issues comment <project>/<number> "<markdown>"`. Per `CLAUDE.md` these are historical
design records — *"Never edit a spec to match the code"* — so leaving them is right. Noting
it only so it does not get refiled as a miss.

## What I verified as good

**Gates, fresh install:** `pnpm check` — 0 errors, 0 warnings across cli/shared/web (1978
files). `pnpm test` — **519 passed** (cli 49, web 470). `pnpm build` — exit 0.

**All five call sites wired, proven end-to-end** (mock API + live API, not by reading):

| criterion | evidence |
|---|---|
| `issues comment <ref> @body.md` | server received `# real body\n` |
| `issues comment <ref> - <<'EOF'` | server received the body verbatim, backticks and `$VARS` intact |
| `@@` escape | `@@alice see above` → posted `@alice see above` |
| `issues create -d @file` | live: description set to the file's exact bytes |
| `issues edit <ref> -d @file` | live: `'# from a file\n\nWith \`backticks\` and $VARS.\n'` |
| `schedules edit -d @file` | error path proves wiring, no write |
| missing `@file` | `error: cannot read …`, exit 1, nothing posted (all 5 sites) |
| inline unchanged | `- 2026-08-31: bullet`, `-x`, `$VAR`/backtick text all literal (unit tests + M1) |
| trailing `--help` / `-h` | help printed, exit 0, nothing posted (new test; W5 confirms teeth) |

**No hang on a bare `-`.** Under an agent harness with no redirect, stdin is a non-TTY
empty pipe, so the TTY guard does not fire — but the emptiness check does:
`error: no Markdown on stdin`, exit 1 in well under a second. Both failure modes are closed,
not just the TTY one.

**The implementer's deviation #1 is correct.** `readBodyValue('--help')` and
`readBodyValue('-h')` are neither `@@`-prefixed, nor exactly `-`/`@-`, nor `@`-prefixed, so
both return verbatim; the guard-first ordering really is defensive rather than load-bearing,
and the revised test comment says so honestly rather than overclaiming. Keeping the ordering
anyway is the right call.

**`journal append`'s resolve-once is correct.** One local, used by all three paths
(`:2080`, used at `:2085`, `:2095`, `:2105`). W3 shows it is untested, not wrong.

**Rendered prompt inspected, not just asserted.** Dumped `issueBlock()` output: the comment
affordance renders as a clean fenced block and the journal suffix renders on one line — the
newline problem the implementer describes fixing is indeed fixed.

## Scope

Complete against the issue and the design's "In scope" list. All four requested call sites,
plus `schedules edit -d` (the design's stated, justified addition), plus the helper
extraction, the unit tests, the `--help` regression test, the three live `context.ts`
strings, `AGENT_GUIDELINES_BODY`, and Tines/69 filed with `Tines/9 blocks Tines/69`
recorded (verified: Tines/69 exists, in Backlog, with Tines/9 as an open blocker). Nothing
in-scope was deferred without approval.

**Screenshots: not applicable** — no UI is added or changed. The diff touches the CLI, a
server-side prompt string builder, a shared constant, and tests; no Svelte component or
route is modified.

## Housekeeping

While verifying `issues create -d @file`, a `cd` in a compound shell command failed, so my
`TINES_API_URL` override never took effect and the command hit the live API instead of the
mock. That created **Tines/70**; I have retitled it `[accidental] …` with an explanatory
description and moved it to Canceled. It is inert. It also, incidentally, provided the live
positive proof for `issues create -d @file` in the table above.
