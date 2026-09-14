# Comparison report

Decision: do not change production defaults. The one runnable lower-effort Codex pair preserved routine correctness, but one pair is not adoption evidence and its cache mix changed materially. Claude accounting was unusable after authentication failed, so the protocol-required stop ended further Claude attempts. Comment-trimming and inline-to-skill comparisons remain unavailable because their approved dependencies are not ready.

## Frozen fixture and allowance

The frozen routine fixture, acceptance script, hashes, and normalized observations are in `comparison-fixtures/effort-routine/`. Checks and hashes were written before invocation. The pair used separate cold sessions and output paths, the same `gpt-6-astra` model and harness version, and changed only effort (`high` to `low`). Four of twelve allowed attempts were consumed; every attempt stayed below five minutes. Attempt 1 discovered that `gpt-5.6` was unavailable to the local Codex account and counts as a failed repair attempt. Attempt 4 discovered expired Claude OAuth and triggered the accounting/authentication stop rule.

Opening content was identical: 97 tokens for `prompt.md` plus `input.txt`, measured with tiktoken `o200k_base`. This is a text estimate, not provider input. Both successful Codex outputs matched `expected.txt` byte-for-byte and passed `acceptance.sh`; their output SHA-256 is `43fa198290e82e956e74d898d0f7148c4823d68b512c8d105b4d0940fa033fdc`.

## Whole-task consumption through acceptance

| Attempt | Harness/model/effort | Acceptance | Elapsed | Input | Cache read | Output | Reasoning |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Codex 0.153.4 / gpt-5.6 / high | unavailable model | 1 s | null | null | null | null |
| 2 baseline | Codex 0.153.4 / gpt-6-astra / high | pass | 12 s | 66,155 | 56,192 | 306 | 0 |
| 3 candidate | Codex 0.153.4 / gpt-6-astra / low | pass | 15 s | 66,070 | 51,968 | 296 | 0 |
| 4 | Claude Code 2.1.258 / claude-sonnet-5 / high | authentication failed | 0.04 s | null | null | null | null |

The candidate used 85 fewer total input tokens and 10 fewer output tokens, but 4,224 fewer cached tokens, so non-cached input increased from 9,963 to 14,102. Elapsed time increased by about three seconds. These are aggregate provider-reported session values including reads and acceptance repairs; per-subcase usage is unavailable. Both requested effort flags were accepted by the local Codex harness, but provider application was unobservable, so the contrast remains unconfirmed.

## Recommendation matrix

| Change | Task class | Codex | Claude Code |
| --- | --- | --- | --- |
| Comment trimming | routine | unavailable: approved /520 comparison not accepted | unavailable: approved /520 comparison not accepted |
| Comment trimming | conditional skill | unavailable: /519 fixture absent and /520 not accepted | unavailable: same dependency gap |
| Comment trimming | long history | unavailable: /520 fixtures remain under review | unavailable: /520 fixtures remain under review |
| Inline-to-skill | routine | unavailable: approved conditional fixture absent | unavailable: approved conditional fixture absent |
| Inline-to-skill | conditional skill | unavailable: /519 has no artifact | unavailable: /519 has no artifact |
| Inline-to-skill | long history | unavailable: /519 fixture absent and /520 not accepted | unavailable: same dependency gap |
| Lower effort, same model | routine | inconclusive: correctness passed; accounting mixed; one unconfirmed pair | inconclusive: authentication/accounting unavailable |
| Lower effort, same model | conditional skill | unavailable: /519 fixture absent | unavailable: fixture and authentication unavailable |
| Lower effort, same model | long history | unavailable: /520 fixtures not accepted | unavailable: fixture and authentication unavailable |

## Rollback

1. Save the current route target JSON and runner tier JSON.
2. Remove the winning routed effort; inspect dispatch because a broader routed value may become effective.
3. Clear applicable local or managed-Claude tier effort to remove all Tines effort, then settle active effort assignments before downgrading the worker.
4. Restore inline/skill/comment fixtures together; retain source instructions until the replacement passes its acceptance checks.

Schema columns and historical run evidence are additive and remain in place. No experiment changed production routing, tiers, prompts, skills, comments, or defaults. Broader adoption requires ordinary-work observation through the existing /498 cohort outputs and new accepted dependency fixtures; no weekly-quota conversion is claimed.
