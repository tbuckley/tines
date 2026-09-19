# tines

The command-line client for [Tines](https://github.com/tbuckley/tines), an issue tracker
built for humans and their agents: work moves through workflows, every action is on the
record, and a supervisor hands eligible issues to agents. This package talks to the same
HTTP API the web app uses.

Awaiting-session continuation policy fields are staged and default off. Runtime continuation is
unavailable until support for the runner's provider is released; configuring thresholds does not
enable continuation.

```sh
npm install -g tines        # or, one-shot with no install:
npx -y tines --help
```

Node 20+. No runtime dependencies. Every push to the repository's `main` publishes a new
version, so `tines --version` always names the API it was built against.

## Pointing it at your Tines

```sh
tines login --api-key tines_…                       # key: Settings → API keys in the web app
tines login --url https://your-tines.example        # only for a deployment other than the default
tines config                                        # what is in effect, and from where
```

The URL defaults to `https://tines.tbuckley.dev`. Or set `TINES_API_URL` and `TINES_API_KEY`
in the environment — that is how agent runs are configured, and the env vars win over the
stored config. `--url` and `--api-key` on any command win over both.

## Everyday commands

```sh
tines projects list
tines issues list --project <project>
tines issues create <project> --title "…" -d @description.md
tines issues create <project> --title "Linked" --blocked-by Other/12 --blocks Other/14 --duplicate-of Other/9
tines issues show <project>/<number>
tines issues move <project>/<number> <action>        # a workflow transition
tines issues transfer <project>/<number> --project <dest>   # move to another project (keeps ID, record and old refs)
tines issues transfer <ref> --project <dest> --dry-run      # review only: no number allocated, nothing written
tines issues transfer <ref> --project <dest> --inspect 0    # print any reviewed guidance item, including retained, in full
tines issues transfer <ref> --project <dest> --yes          # skip the prompt (still commits only the fetched review)
tines issues comment <project>/<number> - <<'EOF'    # body from stdin; @file also works
…
EOF
tines events list --issue <project>/<number>
tines events list --since 2026-09-01T00:00:00Z --until 2026-09-08T00:00:00Z --state Engineering/Review
tines events list --project Tines --all-pages --max-items 20000 --json
tines supervisor stats --window 7d --project Tines
```

Issues are addressed as `<project>/<number>`; schedules as `<project>/<name>`; workflow
states as `<workflow>/<state>`. Every `list` command returns one page — add `--all-pages`
for the whole list — and every command takes `--json` for machine-readable output. Complete
list walks have a default 10,000-item safety ceiling. Use `--max-items <n>` with
`--all-pages` to choose a different positive finite bound; exceeding it fails without
printing a partial result. `--limit` remains the per-request page size. A larger bound keeps
more output in memory and makes more requests, so increase it deliberately or narrow the
list's filters.
`tines <noun> --help` lists the rest: `workflows`, `context`, `journal`, `schedules`,
`runners`, `runs`, `routing`, `supervisor`.

`issues create` accepts repeatable `--blocked-by` and `--blocks` references plus one
`--duplicate-of` reference. The issue and all initial relationships are created atomically.
When a recurrence is also supplied, the relationships apply only to the first issue; later
scheduled instances start without copied relationships.

## Workflow package files

Export a workflow and its inheritance/context closure as canonical JSON, validate an edited
file, then prepare a destination-specific review and save its signed plan:

```sh
tines workflows export <workflow-id> > review.json
tines workflows validate review.json
tines workflows preview review.json --choices choices.json --plan-out review.plan.json
tines workflows install review.json --plan review.plan.json --confirm sha256:<plan-digest>
```

`preview` and `install` also accept a canonical public snapshot URL. Same-instance URLs keep hosted
withdrawal checks; foreign URLs are fetched directly by the CLI without forwarding the destination
API key, cookies, proxy authorization, or referrer. A foreign-source install re-downloads the URL and
requires the exact reviewed bytes. See the
[workflow package guide](https://github.com/tbuckley/tines/blob/main/docs/workflow-packages.md).

Workflow names are accepted only when unique; use the ID when duplicate names exist. Export
selection is explicit: `--project`, repeatable `--schedule`, repeatable
`--tier '<state-id>=balanced'`, `--project-routing`, and `--inputs declarations.json` add
optional source configuration. Package and validation input may be `-` for stdin. Choices use
the shared document-local-ID maps described in
[`docs/workflow-packages.md`](https://github.com/tbuckley/tines/blob/main/docs/workflow-packages.md).

An interactive install prepares and displays the full review, atomically writes a sibling
`<package>.plan.json`, and asks for `yes`. A non-interactive install cannot prepare and commit
in one invocation: it requires a plan from a prior preview and the exact plan digest. There is
no blanket `--yes`. A retry checks the durable receipt first and reuses the same signed plan;
keep the package and plan together until the receipt is returned. Plan files contain the API
base, reviewed response, and signed token, but never the API key; protect them like temporary
authorization material.

## Running agents on your own machine

```sh
TINES_API_KEY=tines_… tines runner install --name laptop --harness claude-code
```

registers this machine as a local runner and installs the daemon as a launchd/systemd
service that polls for work and keeps itself updated (`tines runner daemon` with the same
flags runs it in the foreground instead). See
[docs/runner-daemon.md](https://github.com/tbuckley/tines/blob/main/docs/runner-daemon.md)
for the flags, token rotation, and what the service does.
