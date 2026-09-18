# The local runner daemon

The runner daemon turns a machine into a **local runner**: it polls Tines for issues the
supervisor assigned to it, materializes a per-run workspace, launches your harness (Claude
Code, codex, or a custom command), streams the output back as the run's log, and reports the
finish. No inbound connection to the machine is ever needed. `tines runner install` sets it
up as a service (the normal way); `tines runner daemon` runs it in the foreground.

## First start

Four setup steps from nothing to an agent working an issue. The hosted app is
`https://tines.tbuckley.dev`; self-hosters substitute their own URL everywhere below.

1. **Install** the CLI on the machine that will run agents:

   ```sh
   npm install -g tines
   ```

2. **Key** — Settings → API keys on the app, or click **Create key** in the Agents tab's
   *Add runner → Local* dialog, which also fills it into the command in step 3.

3. **Runner** — install the daemon as a service (or paste the block the dialog shows):

   Using Codex? Configure its [permissions](#codex-permissions) before starting the runner,
   and use `--harness codex`.

   ```sh
   TINES_API_KEY=tines_… tines runner install \
     --url https://tines.tbuckley.dev \
     --name macbook-claude \
     --harness claude-code
   ```

   Name it **machine-plus-harness** — `macbook-claude`. It is what every agent comment says
   ("you via macbook-claude") and what routing rules address. The command registers the
   runner, writes a launchd (macOS) or systemd user (Linux) unit, loads it, and waits for the
   daemon to report in; the Agents tab shows it online within seconds — no reload. See
   "Keep it running" for what it wrote and why. To run the daemon in the foreground instead,
   use `tines runner daemon` with the same flags.

4. **Rule** — a registered runner takes no work until something routes to it. Click
   **Route everything to macbook-claude** in the same dialog, or run
   `tines routing set macbook-claude` for a global rule.

Automation is on by default: eligible work can start as soon as the runner is available and
routing matches. Before your first run, Agents and every issue card show the six milestones
through the first run itself. A description and repository context are optional guidance.
If automation was explicitly stopped, it remains stopped across runner registration and
other settings changes; resume it on Agents or with `tines supervisor enable`.

The first start **registers** the runner and stores its long-lived runner token in the CLI
config directory (`~/.config/tines`, or `$TINES_CONFIG_DIR`). Subsequent starts — the
service's included — reconnect as the same runner using the stored token, so `TINES_API_KEY`
is only needed for registration and never appears in a service unit. Both values can also
come from `tines login` (the same directory's `config.json`) instead of the environment; the
env vars take precedence when set.

Flags (eight are shared by `install` and `daemon`; `install` writes the shared ones you give
into the unit):

| Flag | Meaning | Default |
| --- | --- | --- |
| `--name` | Runner name, unique per user; name it machine-plus-harness, e.g. `macbook-claude` — routing rules and agent comments address it | the hostname |
| `--harness` | `claude-code`, `codex`, or `custom` | `claude-code` |
| `--command` | Custom harness command template; placeholders `{prompt_file}`, `{workspace}`, `{model}`, `{effort}` | — |
| `--max-concurrent` | Simultaneous runs on this machine (1–100), or the machine-owned ceiling when remote adjustment is enabled | 1 |
| `--allow-remote-concurrency` | Let signed-in operators request a cap up to the local ceiling; never enabled remotely | off |
| `--poll-interval` | Seconds between polls | 15 |
| `--keep-workspaces` | Keep settled runs' workspaces for debugging: `never`, `failed`, or `always` | `never` |
| `--keep-workspaces-for` | Hours a kept workspace survives | 72 |
| `--keep-workspaces-max` | Most kept workspaces to hold at once (oldest go first) | 20 |
| `--no-cli-refresh` | Foreground `daemon` only: skip the managed CLI install; harnesses use whatever `tines` is on the ambient PATH | refresh on |
| `--no-self-update` | Foreground `daemon` only: never exit for the service manager to relaunch a newer daemon (see "Keeping the daemon itself current") | self-update on |

The service created by `runner install` always keeps both the harness-facing CLI and the daemon
itself current, so `install` does not accept the two `--no-*` flags.

Custom command placeholders are shell-quoted before the daemon passes the expanded template
to `sh -c`. A missing model or effort expands to the empty shell word `''`, so the flag can
remain in the template: `my-runner --prompt {prompt_file} --model {model} --effort {effort}`.
The effort placeholder forwards an effort already present on the assignment; it does not
enable effort routing for custom harnesses, which currently advertise no effort capability.

Each run's workspace (under the config dir) contains `prompt.md` (supervisor preamble +
stitched context + issue block), `skills/<name>/…`, `repos.json`, and a clone of each listed
repository made with the machine's own git credentials. The harness runs with
`TINES_API_KEY` set to the run's ephemeral key and `TINES_API_URL` set to the API base.
When the run settles the workspace is deleted, unless `--keep-workspaces` says otherwise
(see "Debugging a failed run") or the supervisor retained it for a resume — a run that moved
its issue into a state awaiting a human keeps its workspace whatever the mode, so the
send-back can continue in it (see "Resuming a send-back"). `--keep-workspaces-for` and
`--keep-workspaces-max` bound those the same way.

The [Code repository starter](../README.md#your-first-project-hosted) stores its repository
URL and optional base branch as project context. Effective issue context exports that pin
to `repos.json`, and the daemon clones and checks out the repository before starting the
harness. The runner machine's git credentials must allow it to clone the repository—and,
for the bug-to-PR journey, push a working branch and open a pull request. The starter does
not test repository reachability. The supplied branch is the input base branch, distinct
from the working branch the agent creates for its fix.

Rotating a token: `tines runners rotate-token <name>` invalidates the old token and prints
the new one once. Run it on the daemon machine and the stored token is updated in place —
just restart the daemon; elsewhere, the daemon exits with a clear 401 message until the new
token is dropped into its config.

## Codex permissions

Before starting a Codex runner, edit or create `~/.codex/config.toml` for the OS user that
runs the daemon. For the usual service installed by `tines runner install`, merge these
settings into that file:

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
```

`sandbox_mode` is a top-level key, so place it before any table headers. If the file already
has a `[sandbox_workspace_write]` table, update it instead of adding a duplicate table.

Workspace-write lets Codex edit the per-run workspace, including cloned repositories.
Outbound network access lets subprocesses such as `tines` reach `TINES_API_URL`; it permits
connections beyond that Tines server too.

These are defaults for every Codex session run by this OS user. Commands with network access
can send data off the machine, so enable these permissions only for work and repositories
you trust. Tines gives each run an ephemeral API key and revokes it when the run ends; do not
put that key in Codex configuration. The key's lifetime does not restrict network
destinations.

Tines invokes `codex exec` without overriding its sandbox or network settings. The snippet
uses Codex's sandbox configuration and is not compatible with `default_permissions` or the
permission-profile configuration model. If you use a permission profile, consult the
[OpenAI configuration reference](https://developers.openai.com/codex/config-reference) for
your chosen model before editing it; do not remove organization-managed policy. See
[Config basics](https://developers.openai.com/codex/config-basic) for configuration
precedence and managed constraints. A foreground daemon or custom service explicitly given
`CODEX_HOME` reads configuration from that home; the normal Tines installer does not copy an
arbitrary shell `CODEX_HOME` into its service unit.

If a new run cannot edit files or `tines` reports a network denial, check the configuration
used by the daemon's OS user and any higher-priority or managed policy, then start another
run. An online runner confirms only that registration and heartbeat work. These settings do
not guarantee authentication, DNS, or every Git operation, and Tines does not recommend
`danger-full-access`, changing approval policy, or bypassing managed restrictions.

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

### Keeping the daemon itself current

The refresh above updates the CLI *agents* run. The daemon process is whatever binary the
service manager launched, and a long-lived daemon silently falls behind the API it polls —
a feature that ships in the daemon (the rendered `claude_code` stream, say) does not show
up until someone restarts it. The daemon cannot replace itself while it runs, so the
mechanism is the classic one: it notices, drains, and exits, and the service manager brings
it back.

When replacing an older source-launched daemon, first identify its controlling service and verify both local and supervisor active-run inventories are empty. Stop that launcher so it cannot respawn, then start the same runner name, harness, concurrency and configuration from the managed prefix under launchd/systemd. Recheck idleness immediately before stopping: an earlier read is not a dispatch lock. Confirm exactly one process reconnects and that a newly completed run's launch banner reports the new daemon version. Refreshing the child `tines` CLI does not upgrade the long-running daemon, and package publication alone is not adoption proof.

Concretely, when the daemon was launched **from the managed prefix** —

```sh
~/.config/tines/cli/node_modules/.bin/tines runner daemon --name macbook-claude --harness claude-code
```

— every refresh that installs a newer `tines` than the running daemon starts a drain: the
daemon keeps polling but reports `draining`, so the supervisor assigns it nothing new (runs
it already claimed are still delivered and finished; the runner card reads "restarting to
update" meanwhile), and once no run is in flight it exits 0 with a log line saying so. The
`KeepAlive` / `Restart=always` in the units below relaunch it, now from the updated
prefix. An idle daemon checks the registry on the same 10-minute cadence a busy one does
before launches, so an update lands within about ten minutes plus the length of whatever
is running. Notes:

- **It only ever acts from the prefix.** Launched from a global install or a `pnpm link`,
  an exit would relaunch the same old binary, so the daemon logs once at startup that
  self-update is off and where to launch it from instead. Its own version is stamped in
  every run's launch banner (`cli=…`), which is how you tell which daemon ran a run.
- **`tines runner install` does all of this for you.** It builds the prefix if it is
  missing, registers (or reconnects) the runner, and writes a unit that launches the daemon
  from the prefix path — see "Keep it running". The rest of this list is what that unit
  encodes, for when you need to write one by hand.
- **It exits deliberately, so run it under a service manager.** Started by hand in a
  terminal from the prefix, the daemon stops instead of restarting; pass
  `--no-self-update` for that, or just relaunch it. `--no-cli-refresh` implies it.
- **It never kills a run to update**, and never restarts into a half-installed prefix:
  the exit waits for an in-flight `npm install` to finish first.

### The harness's own CLI is yours to keep current

The refresh above covers `tines` and nothing else — the daemon never installs or updates
`claude`, `codex`, or a custom harness binary. That matters because the model the daemon
passes as `--model` comes from the server, per run, and a harness can be too old for it: the
built-in `smartest` tier for `claude_code` resolves to `claude-fable-5-1`, which **requires
Claude Code 2.1.251 or newer**. An older `claude` fails the run in seconds with a
server-side 400 (`does not support this model`), which reads as a failing agent rather than
a stale install. Keep it current with `claude update`.

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

4. The harness's stdout and stderr. Claude Code and Codex both run in structured JSON mode,
	 which the daemon renders as readable `[agent]`, `[tool]`, `[session]`, and `[error]` lines.
	 For Claude Code, `--raw` fetches the unrendered NDJSON.
5. The **exit line**: `# tines runner: exit code=0 after 3m12s`, or `signal=SIGTERM` when
   something killed it, with `(timed out)` when that something was the daemon's own
   timeout. A run canceled by the supervisor has no exit line — the daemon stops logging
   the moment the supervisor settles the run.
6. `workspace kept at <path>`, only when `--keep-workspaces` retained this run's
   workspace (see below). It is the daemon's own note about what it left on disk, so it
	 comes after the harness's exit line rather than before it. A workspace held for a
	 resume is announced on the daemon's own console instead — `run <id> workspace kept for
	 resume at <path>` — because the retention is only known once the finish report comes
	 back, by which time the run's log is closed.

When a structured harness finishes, its terminal report is also saved on the run. Claude
Code supplies a provider-reported cost, input/output/cache tokens, and its session id. Codex supplies
complete cumulative input/output/cache-read/cache-write evidence and its thread id; the server
calculates supported models using the immutable policy in [Codex run pricing](codex-pricing.md).
Unsupported or incomplete evidence remains visibly Unpriced. Custom harnesses and processes that stop before
a terminal usage event are marked `unreported`. Usage already emitted is retained even when
the harness exits unsuccessfully. The session/thread id is shown on the run row and by
`tines runs show`, and is what a resumed launch continues.

## Resuming a send-back

A run that hands its issue back to a human usually gets sent back to the same stage minutes
or hours later, and today that means a cold start: fresh workspace, fresh clone, and an
agent re-reading the repository from zero. When the runner is opted in (Agents → the
runner's resume settings, off by default), the supervisor instead keeps the finished run's
workspace and its harness session, and the send-back is delivered as a continuation:

- the daemon launches in the **kept workspace** — no wipe, no re-clone, no skills or
  `repos.json` rewrite; only `prompt.md` changes;
- Claude Code is launched as `claude -p --resume <session-id> …`, so the conversation
  carries on rather than starting over;
- the prompt is the reduced continuation message (what changed since the last run, the
  current stage's instructions and the issue block), not the full cold launch prompt;
- the issue block uses the same essential-comment selection and skill discovery as a cold
  launch. Older agent comment IDs resolve current bodies through `tines issues show --json`;
  bodies already present in the retained conversation cannot be removed retroactively;
- the launch banner names it: `# tines runner: … resumed=<previous-run-id>`, and the run
  row says `resumed run <id>`.

Every guard falls back to a normal cold launch, silently: a window that has closed (48h by
default), a previous conversation that has grown past the runner's size guards, a different
runner, a changed model or harness, or a workspace that is no longer on disk (the daemon
logs `resume workspace <path> is gone; launching fresh`). Nothing about a resumed run is
required for correctness — it is only the clone and the re-exploration that are skipped.

## Keep it running

The runner is infrastructure: it runs under your OS's service manager so it survives logouts
and reboots, and it is launched from the managed prefix, which is what lets it update itself
(see "Keeping the daemon itself current"). `tines runner install` sets both up:

```sh
TINES_API_KEY=tines_… tines runner install --name macbook-claude --harness claude-code
```

To let the Agents page adjust concurrency, opt in locally and set the highest value this
machine may run:

```bash
TINES_API_KEY=tines_… tines runner install --name macbook-claude --harness claude-code \
  --allow-remote-concurrency --max-concurrent 4
```

The web request starts at 1 for a new runner and can never exceed 4 in this example. Raising it
can increase CPU, memory, network, and provider usage or cost. To disable adjustment, pause the
runner, wait for zero active runs, uninstall it, then reinstall with the complete desired flags
but without `--allow-remote-concurrency`. `runner restart` preserves the installed arguments and
therefore does not change this policy. Lowering the requested cap lets existing runs finish and
blocks new claims until usage is below the new cap.

In order, it:

1. **Refuses if a daemon for that name is already running** — one started in a terminal,
   from a global install, from a source checkout, or by the service itself. Loading a
   service beside it would run the runner twice, and the old process would keep its stale
   binary. Pause the runner (`tines runners pause macbook-claude`), wait for `0/N` active
   runs, stop that process, and run install again; it reconnects with the stored token, so
   no key is needed the second time.
2. **Builds the managed prefix** (`~/.config/tines/cli`) when it is missing, with the same
   npm install the refresh uses.
3. **Registers or reconnects** the runner: the stored token when there is one, otherwise a
   registration with `TINES_API_KEY`, whose token is then stored. The key goes no further.
4. **Writes the unit** — `~/Library/LaunchAgents/dev.tines.runner.<name>.plist` on macOS,
   `~/.config/systemd/user/tines-runner-<name>.service` on Linux. It launches
   `~/.config/tines/cli/node_modules/.bin/tines runner daemon` with the flags you gave, a
   `PATH` naming the directories `node`, the harness binary (`claude`/`codex`) and `git` were
   found in, `KeepAlive` / `Restart=always` (the daemon exits 0 on purpose to pick up a
   self-update), and the daemon's console output appended to
   `~/.config/tines/logs/runner-<name>.log`. There is no credential in it. A harness binary
   that is not on your PATH is a warning: install it and run install again to pick up its
   directory.
5. **Loads it** (`launchctl bootstrap gui/$UID …`, or `systemctl --user enable --now` plus
   `loginctl enable-linger` so it runs while nobody is logged in) and **waits up to 30 s**
   for the daemon's own `reconnecting as runner "…"` line in that log. A daemon that never
   reports in is a failure, with the log path to read; a wrong `node` on the service PATH or
   a rejected token shows there.

Afterwards:

- `tines runner restart macbook-claude` relaunches the service (`launchctl kickstart -k` /
  `systemctl --user restart`). It interrupts runs in flight — pause the runner and wait for
  zero active runs first when that matters. A newer release does not need it: the daemon
  drains and restarts itself.
- `tines runner uninstall macbook-claude` stops the service and removes the unit. The stored
  token stays, so a later install reconnects without a key.
- Changing flags means `uninstall`, then `install` with the new ones (install refuses to
  replace a running service, per step 1).
- `--service-manager launchd|systemd` overrides the platform default, which is only useful
  for testing the unit text.

`launchctl print gui/$(id -u)/dev.tines.runner.macbook-claude` (macOS) or
`systemctl --user status tines-runner-macbook-claude` (Linux) shows what the service manager
thinks; every run's launch banner shows which daemon binary actually ran it (`cli=…`).

## Failure behavior

- **Daemon crash/restart**: on startup the daemon kills harness processes recorded in its
  state file, reports their runs failed, and removes their workspaces (or keeps them, under
  `--keep-workspaces`). The supervisor also
  fails `running` runs missing from the daemon's `owned_runs` report, and fails everything
  after 5 minutes offline.
- **Ctrl-C / SIGTERM**: in-flight runs are killed and finish-reported as failed before exit.
- **Self-update restart**: never interrupts a run — the daemon drains first (nothing new is
  dispatched to it, its card reads "restarting to update") and exits only once idle, for
  the service manager to relaunch. A daemon that dies mid-drain does not leave its runner
  shut: `draining` is stated on every poll, so the next poll from any daemon clears it.
- **Duplicate daemon / copied token**: the most recently admitted daemon boot becomes the
  runner's current instance. The superseded daemon's next poll is rejected before it can
  update the heartbeat, reconcile `owned_runs`, or receive work; it logs the runner name,
  finish-reports local runs as interrupted, and exits. The compatibility fence remembers
  only the immediately previous modern boot; old daemons that omit an instance id are not
  fenced. An already-admitted poll may overlap the takeover, and run log/finish requests
  still use the shared runner token. If `KeepAlive` or `Restart=always` keeps relaunching a
  duplicate service, stop and disable that service or register it under a different runner
  name — otherwise the two service managers can keep creating new boots and taking over.
- **Cancel / timeout from the supervisor**: the next poll's `cancels` list makes the daemon
  kill the process without reporting — the supervisor already settled the run. The daemon
  also enforces the run timeout locally. Both count as failures for `--keep-workspaces`.
- **Claude usage limit**: when the harness reports a usage limit — as a rejected
  `rate_limit_event` on its stream, or as its own message on stderr when the limit was
  already spent before the process started — the daemon finish-reports the run as rate
  limited rather than failed. The issue takes no strike, and the runner's card reads
  "rate limited — resumes <time>" until the window resets. Nothing needs doing: the
  supervisor dispatches to it again on its own. A weekly limit is re-probed once a day,
  which costs one run that ends in about a second.
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

## Reasoning effort

Current Codex and Claude Code daemons discover and report exact-model effort support at boot. Set routed effort by target position, for example `tines routing set codex:balanced claude:balanced --project Example --effort 1=low --effort 2=medium`. A runner-tier effort is the fallback when routing omits it. Explicit routed effort never launches through an old or incompatible daemon; the next compatible ordered target may win.

During daemon rollout, an old daemon may still take a run that has only runner-tier effort. Tines omits the setting and records `legacy_not_applied`; actual provider effort is unknown. After upgrade, Claude receives `--effort VALUE` and Codex receives `-c model_reasoning_effort="VALUE"`. Successful local spawn is recorded as `accepted_unconfirmed`, not proof of internal reasoning depth.

To roll back, save the current route/tier JSON, remove routed effort and every applicable local tier effort, inspect `tines issues dispatch`, then settle active effort assignments before downgrading the server. Clearing a route override alone can reveal a broader override or runner-tier fallback.
