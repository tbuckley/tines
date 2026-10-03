# Pi as a local runner harness (2026-10-03)

This record adds a fourth local harness kind, `pi`, for the Pi coding agent
(`@earendil-works/pi-coding-agent`) run against models served on the runner's own machine
(Tines/900). It is launched as `pi --mode json` with the prompt on stdin and its JSON event
stream is rendered into the run log as it arrives. The decisions below were taken against
`pi` 0.99.2, probed on a runner with a mock model endpoint. The operator guide and the
feature-by-feature parity table are in `docs/runner-daemon.md`, "Pi".

## Decisions

**D1. A new harness kind, not a better `custom`.** `custom` has no stream contract to parse,
so it can have no rendered log, usage, effort evidence or resume. The harness lives in
`runner.config` JSON, so there is no migration.

**D2. The launch.** `sh -c "pi --mode json --no-approve --session-dir <ws>/.pi-sessions
[--session <id>] [--model <m>] [--thinking <effort>] [--skill .agents/skills/<name>]… <
prompt.md"`. `--approve` was rejected: it would also trust any `.pi/` extensions a cloned
repository carries. Pi ignores `.agents/skills` in an untrusted folder, so each materialized
skill is named explicitly. Sessions go in `.pi-sessions`, not `.pi/sessions`, to stay out of
Pi's project-configuration directory.

**D3. The outcome is judged from the stream, not the exit code.** Pi exits 0 on a 429, a 500
and a refused connection.

**D4. No built-in tier table.** The models are whatever the machine has. Per-runner tier
overrides name them as `provider/id`; a tier with no override launches without `--model` and
Pi uses its own default. `Runner.tiers_apply` says the tier editor applies, because
`tier_models === null` already means "tiers do not apply" for `custom`.

**D5. Effort needs a named model.** The capability check is per exact model, and guessing
Pi's default model would make it inexact. A tier with an effort and no model resolves to the
reason `model_required`.

**D6. Effort is confirmed.** Pi clamps an unsupported thinking level silently, so
`accepted_unconfirmed` would let a clamped run pass as enforced. The first non-error
assistant message records the `thinkingLevel` Pi applied: a match is evidence `confirmed`, a
mismatch kills the run with evidence `rejected` naming the observed level.
`accepts_asserted_effort` is not set for Pi, because the probe catalog is the machine's whole
model list. This needed the server to accept `confirmed` from a daemon and to keep a
confirmed effort in the resume fingerprint.

**D7. Usage.** Tokens are the sum of each assistant message's `usage` plus tool-result usage.
All zeros means the model server reported nothing: no token fields are sent, and the run log
carries one characters÷4 estimate labelled as not recorded. Tokens without a cost carry no
`cost_source`, since `'none'` with tokens is counted as inconsistent by usage accounting. A
non-zero `cost.total` is recorded as `cost_usd` with `cost_source: 'provider'`.

**D8. Resume reuses the existing kept-workspace resource row** (`run_resource.kind =
'local_claude'`). The kind only means "a kept workspace, guarded by turn count", and the
resume fingerprint already includes the harness, so a Claude session can never be claimed by
a Pi run. A new `local_pi` kind would have needed a table rebuild for a name.

**D9. Credentials come from the daemon's own environment.** `tines runner install` runs
`pi --list-models` with only the unit's `PATH` and `HOME` and warns when it lists nothing. A
Tines env item still reaches the run, but not the capability probe, so a model that needs it
is absent from the catalog. Writing secrets into a launchd plist or systemd unit was
rejected.

**D10. Version floor 0.99.2.** `message_update` and `agent_settled` changed shape before
0.99. Below the floor, install stops and the probe reports a `discovery_error`.

**D11. The raw stream upload drops `message_update`, `message_start` and
`tool_execution_update`, and reduces `agent_end` to its type.** `message_update` fires per
token and `agent_end` repeats every message; under the size cap they would crowd out
everything else.

**D12. Rate limits use structured signals only** (`auto_retry_end.success === false`, a final
`stopReason` of `error` or `aborted`). Claude's prose patterns do not apply. Pi reports no
reset time, so there is no `resume_at` and the server's default backoff applies.

## Out of scope

- **Estimated tokens in usage accounting.** Storing an estimate needs an "estimated" marker
  through `AgentRunUsage` and every rollup so it never mixes with reported tokens.
- **Pi's RPC mode or SDK for runs.** JSON mode covers a run; RPC is used only for the
  capability probe.
- **A `--max-run-minutes` install flag.** The run timeout is already per runner.

## Decided during delivery

- A `rejected` effort that follows `accepted_unconfirmed` only wins when it names what was
  observed, so the daemon sends `observed_effort` with a Pi mismatch.
- The estimate line is written only when the model answered at least once.
- An effort mismatch is a plain failure and takes a strike.
- Pi with no models reports an empty catalog rather than a discovery error; the install
  warning is where the operator hears about it. A model whose `set_model` fails (no
  credentials) is left out of the catalog.
- When a resumed run's session file is gone, the run launches fresh and its turn count
  restarts.
- The install preflight checks the `pi` the unit's `PATH` resolves to, which is the one the
  daemon launches and is not always the installing shell's first.
