# Execute one runner assignment

A supervisor can launch `tines runner execute` once for each assignment returned by its runner poll. It writes the assignment to stdin, closes stdin, and consumes stdout until EOF. The supervisor owns its runner token, poll loop, cancellation acknowledgements, delivery retries, and workspace retention. The executor uses the assignment's ephemeral run key for the agent-facing Tines CLI.

From the repository root, try the bundled example with a local custom harness:

```sh
tines runner execute --no-cli-refresh --harness custom --command 'cat {prompt_file}' \
  < docs/examples/runner-assignment.json
```

## Input

Send one UTF-8 JSON document conforming to the [assignment schema](../packages/cli/schemas/runner-assignment.schema.json). Forward the complete poll assignment, including optional environment, effort, and resume fields when present. The schema comes from the shared `RunnerAssignment` type. The [example](examples/runner-assignment.json) contains a dummy key.

Select the harness with the daemon's usual `--harness` and custom `--command` flags. The default is Claude Code. Supply the API base URL with `--url` or `TINES_API_URL`. The assignment must come from that instance. The executor uses the existing CLI refresh behavior; use `--no-cli-refresh` with a supervisor-provisioned CLI on PATH when sharing a configuration directory across concurrent executor processes.

Fresh runs get separate directories under the configured Tines workspaces directory. Use the same `TINES_CONFIG_DIR` for a continuation so its saved workspace is accessible. Schedule at most one invocation for an assignment or retained workspace at a time. A missing retained workspace triggers the CLI's usual fresh-launch fallback.

## Output

Each stdout line is one UTF-8 JSON object conforming to the [event schema](../packages/cli/schemas/runner-event.schema.json). Both schemas ship in the npm package's `schemas/` directory. Human-readable executor diagnostics go to stderr. Harness stderr goes through the usual Tines run-log processing.

| Event | Supervisor action |
| --- | --- |
| `workspace` | Record the absolute workspace path as soon as the assignment is tracked. It also identifies the directory for cleanup if the executor exits early. |
| `started` | Record the harness process-group leader PID and launch time (epoch milliseconds) in the supervisor’s active-run inventory. These identify a child in the executor’s PID namespace for orphan recovery. |
| `log` | POST `body` unchanged to `/api/v1/runs/{id}/logs` as it arrives. Preserve ordering and reuse the sequence number on retry. An empty chunk can carry an effort milestone. |
| `raw_log` | Base64-decode each `data` field separately and concatenate the bytes in order. Spool them until settlement, then PUT the complete body to `/api/v1/runs/{id}/log/raw` as `application/x-ndjson`. This is the same best-effort, redacted, size-limited Claude Code or Pi artifact as the daemon's. |
| `finish` | After outstanding log appends complete, POST `body` unchanged to `/api/v1/runs/{id}/finish`. Use the returned run's `resume_expires_at` and your configured retention policy to keep or remove `body.workspace_path`. |
| `canceled` | The supervisor already settled this run. Apply workspace retention to `workspace_path` and acknowledge the cancellation through the normal poll protocol when applicable. |

For example, these records show a log append and a completed run:

```jsonl
{"type":"log","body":{"seq":1,"chunk":"Reviewed the issue.\n"}}
{"type":"finish","body":{"status":"completed","usage":{"cost_source":"none"},"workspace_path":"/srv/tines/workspaces/run_123-a1b2c3"}}
```

A complete stream ends with exactly one `finish` or `canceled` record. The executor leaves the workspace available to the supervisor after exit, including on failure. The finish payload includes the daemon's judgment, effort, turn counts, session ID, usage, and pricing evidence whenever the harness and assignment supply them. Keep optional fields intact.

## Process lifecycle

- Exit 0 means the executor delivered a complete report. A harness failure or timeout is a `finish` with `status: "failed"` and can have exit 0.
- Malformed input or an executor/protocol failure exits nonzero. A missing terminal event means the stream is incomplete. Use normal supervisor recovery for an interrupted invocation.
- Send SIGTERM for an already-settled supervisor cancellation. Send SIGINT for executor shutdown that needs a failed finish with an interrupted judgment. While the harness is running, the executor signals its process group and escalates if necessary. A signal racing a run already finishing leaves its finish in place.

For changes to the shared types, run `pnpm --filter tines runner:schemas`. The package check verifies that the committed schemas match the types.
