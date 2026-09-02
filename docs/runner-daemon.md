# The local runner daemon

`tines runner daemon` turns a machine into a **local runner**: it polls Tines for issues the
supervisor assigned to it, materializes a per-run workspace, launches your harness (Claude
Code, codex, or a custom command), streams the output back as the run's log, and reports the
finish. No inbound connection to the machine is ever needed.

## First start

```sh
TINES_API_KEY=<your user API key> TINES_API_URL=https://your-tines.example \
  tines runner daemon --name laptop-m4 --harness claude-code
```

The first start **registers** the runner (it appears on the Agents tab within seconds) and
stores its long-lived runner token in the CLI config directory (`~/.config/tines`, or
`$TINES_CONFIG_DIR`). Subsequent starts reconnect as the same runner using the stored token —
`TINES_API_KEY` is only needed for registration.

Flags:

| Flag | Meaning | Default |
| --- | --- | --- |
| `--name` | Runner name (unique per user; routing rules address it) | the hostname |
| `--harness` | `claude-code`, `codex`, or `custom` | `claude-code` |
| `--command` | Custom harness command template; placeholders `{prompt_file}`, `{workspace}`, `{model}` | — |
| `--max-concurrent` | Simultaneous runs on this machine (1–100); sent on every poll, so a restart with a new value updates the server-side cap | 1 |
| `--poll-interval` | Seconds between polls | 15 |
| `--no-cli-refresh` | Skip the managed CLI install; harnesses use whatever `tines` is on the ambient PATH | refresh on |
| `--keep-workspaces` | Keep settled runs' workspaces for debugging: `never`, `failed`, or `always` | `never` |
| `--keep-workspaces-for` | Hours a kept workspace survives | 72 |
| `--keep-workspaces-max` | Most kept workspaces to hold at once (oldest go first) | 20 |

Each run's workspace (under the config dir) contains `prompt.md` (supervisor preamble +
stitched context + issue block), `skills/<name>/…`, `repos.json`, and a clone of each listed
repository made with the machine's own git credentials. The harness runs with
`TINES_API_KEY` set to the run's ephemeral key and `TINES_API_URL` set to the API base.
When the run settles the workspace is deleted, unless `--keep-workspaces` says otherwise
(see "Debugging a failed run").

Rotating a token: `tines runners rotate-token <name>` invalidates the old token and prints
the new one once. Run it on the daemon machine and the stored token is updated in place —
just restart the daemon; elsewhere, the daemon exits with a clear 401 message until the new
token is dropped into its config.

## The agent-facing CLI

Every push to `main` deploys the API **and** publishes a new `tines` to npm, so a launch
prompt is always current — while a hand-installed CLI on the runner machine is whatever a
human last put there. That skew is silent in the dangerous direction: a prompt that teaches
a new *positional* (rather than a flag) is taken verbatim as data by an old CLI, which
succeeds and does the wrong thing.

So the daemon maintains its own copy. At start, and before each launch if the last attempt
is more than 10 minutes old, it runs:

```sh
npm install --prefix ~/.config/tines/cli tines@latest --min-release-age=0 --no-audit --no-fund
```

and prepends `~/.config/tines/cli/node_modules/.bin` to the harness's `PATH`. Notes:

- **Your global `tines` is never touched.** In particular a `pnpm link --global` dev setup
  (README, "If you're actively hacking on the CLI") keeps working — that is why this is a
  private prefix rather than `npm i -g`.
- `--min-release-age=0` is required, not hygiene. npm's supply-chain delay
  (`min-release-age` in `~/.npmrc`) refuses versions younger than the configured window,
  and because CI publishes on every merge the newest `tines` is essentially always inside
  it — without the override the refresh is a permanent `ENOVERSIONS` no-op. The override
  is scoped to this one install of a first-party package; your global npm config is
  unchanged.
- **Failures never fail a run.** npm missing, registry unreachable, or an install hanging
  past 60s all degrade to the last-good copy in the prefix, then to the ambient `PATH`.
  The daemon logs it, and every run's log records which CLI executed it on its first line.
- To reset, delete `~/.config/tines/cli` (it is rebuilt on the next refresh). To opt out
  entirely, pass `--no-cli-refresh`.
- **Restart the daemon after upgrading it.** The refresh runs inside the daemon process, so
  a daemon that has been up since before this feature shipped never performs one: the prefix
  is simply absent and every harness silently falls through to the ambient `PATH`. If agents
  report a `tines` older than npm's, check the daemon first — `ls ~/.config/tines/cli`
  (missing prefix), then `tines --version` against `npm view tines version`.

## What a run's log contains

The log a run leaves behind (`tines runs show <id> --logs`, or the run view in the UI) is
written by the daemon and by the harness, in this order:

1. `$ git clone …` for each of the issue's effective repos, with git's own output.
2. A line naming the agent-facing `tines` that will be on the harness's `PATH`.
3. The **launch banner** — what the daemon is about to run, and under what settings:

   ```
   $ claude -p --output-format stream-json --verbose --model 'claude-sonnet-5' < '/…/prompt.md'
   # tines runner: harness=claude_code model=claude-sonnet-5 timeout=30m cli=0.0.84 workspace=/…/arun_xxx
   ```

   The first line is exactly what was executed: for `claude_code` and `custom` it is the
   `sh -c` script string, with a custom `--command` template already expanded, so a
   template that expanded badly is visible rather than inferred (a template containing
   newlines renders across as many lines — the block is two lines only when the command
   is one). `model=(fixed)` means the harness cannot vary its model. `cli=` is the
   daemon's own version, not the agent's. The run key is never here — it rides in the
   harness's environment, never in argv.

4. The harness's stdout and stderr (for `claude_code`, the rendered stream; `--raw` fetches
   the unrendered NDJSON).
5. The **exit line**: `# tines runner: exit code=0 after 3m12s`, or `signal=SIGTERM` when
   something killed it, with `(timed out)` when that something was the daemon's own
   timeout. A run canceled by the supervisor has no exit line — the daemon stops logging
   the moment the supervisor settles the run.
6. `workspace kept at <path>`, only when `--keep-workspaces` retained this run's
   workspace (see below). It is the daemon's own note about what it left on disk, so it
   comes after the harness's exit line rather than before it.

## Keep it running

The runner is infrastructure: run it under your OS's service manager so it survives logouts
and reboots.

### macOS (launchd)

Save as `~/Library/LaunchAgents/dev.tines.runner.plist` (adjust the paths, name, and URL):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.tines.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/tines</string>
    <string>runner</string>
    <string>daemon</string>
    <string>--name</string><string>laptop-m4</string>
    <string>--harness</string><string>claude-code</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TINES_API_URL</key><string>https://your-tines.example</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tines-runner.log</string>
  <key>StandardErrorPath</key><string>/tmp/tines-runner.log</string>
</dict>
</plist>
```

Register once interactively first (so the token is stored), then:

```sh
launchctl load ~/Library/LaunchAgents/dev.tines.runner.plist
```

### Linux (systemd user unit)

Save as `~/.config/systemd/user/tines-runner.service`:

```ini
[Unit]
Description=Tines local runner daemon
After=network-online.target

[Service]
ExecStart=/usr/local/bin/tines runner daemon --name workstation --harness claude-code
Environment=TINES_API_URL=https://your-tines.example
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now tines-runner
loginctl enable-linger "$USER"   # keep it running while logged out
```

## Failure behavior

- **Daemon crash/restart**: on startup the daemon kills harness processes recorded in its
  state file, reports their runs failed, and removes their workspaces (or keeps them, under
  `--keep-workspaces`). The supervisor also
  fails `running` runs missing from the daemon's `owned_runs` report, and fails everything
  after 5 minutes offline.
- **Ctrl-C / SIGTERM**: in-flight runs are killed and finish-reported as failed before exit.
- **Cancel / timeout from the supervisor**: the next poll's `cancels` list makes the daemon
  kill the process without reporting — the supervisor already settled the run. The daemon
  also enforces the run timeout locally. Both count as failures for `--keep-workspaces`.
- **Network errors**: polls retry with backoff; the loop never crashes. A 401 (rotated
  token) exits with instructions instead of spinning.
- **CLI refresh failure**: never fails a run — the last-good copy is used, or the ambient
  `PATH`, with a warning in the daemon log and in each affected run's log.

## Debugging a failed run

When a run fails, the run's log is usually all that survives: the workspace — the clone the
agent was editing, the `.git` state that explains a failed push, whatever the harness wrote
to disk — is deleted the moment the run settles. That is the right default, and the wrong
one when you are trying to salvage 29 minutes of work an agent never pushed.

```sh
tines runner daemon --keep-workspaces failed
```

`failed` keeps the workspace of every run that did not complete: a timeout, a cancel (from
`tines runs cancel` or the UI), a harness that exited non-zero, a clone or setup failure, an
orphan killed on restart, and any run in flight when you Ctrl-C the daemon. `always` keeps
completed runs too; `never` (the default) is today's behaviour.

A kept workspace stays at `<configDir>/workspaces/<run_id>` (`~/.config/tines`, or
`$TINES_CONFIG_DIR`) with a `kept.json` next to `prompt.md` saying what it was:

```json
{
  "run_id": "arun_6q7lbleyC82NzLBB",
  "issue_ref": "Tines/19",
  "status": "failed",
  "error": "run exceeded the 30m timeout; harness killed",
  "kept_at": "2026-08-31T21:50:26.360Z"
}
```

To find one:

```sh
tines runner workspaces          # RUN, ISSUE, STATUS, AGE, SIZE, PATH
tines runs show <run-id> --logs  # daemon-reported finishes end with "workspace kept at <path>"
```

The log line lands for finishes the daemon reports — timeout, non-zero exit, clone failure,
shutdown. A run the *supervisor* settled (a cancel, or the 5-minutes-offline sweep) has
already ended by the time the daemon lets go, and the API rejects an append to it; those
runs are still kept, and `tines runner workspaces` plus the daemon's own stdout are how you
find them.

The repository clones inside are ordinary checkouts made with your git credentials, so
salvaging is just git: `cd` in, `git -C <dir> status`, commit what the agent left, and push.

**Watch the disk.** A workspace is a few megabytes at materialization and can pass 700 MB
once the agent installs dependencies, so this is not a flag to leave on forever. Two bounds
apply, swept on startup and after every finish: anything older than `--keep-workspaces-for`
hours goes, and beyond `--keep-workspaces-max` the oldest go. Clear them by hand with:

```sh
tines runner workspaces prune --older-than 24
tines runner workspaces prune --all
```

Both sweeps and both commands only ever delete a directory containing a `kept.json`. The
workspaces directory is shared by every run of every daemon on the machine, so an unmarked
directory is assumed to be a live run and is left alone.
