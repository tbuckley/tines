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
```

Issues are addressed as `<project>/<number>`; schedules as `<project>/<name>`; workflow
states as `<workflow>/<state>`. Every `list` command returns one page — add `--all-pages`
for the whole list — and every command takes `--json` for machine-readable output.
`tines <noun> --help` lists the rest: `workflows`, `context`, `journal`, `schedules`,
`runners`, `runs`, `routing`, `supervisor`.

## Running agents on your own machine

```sh
TINES_API_KEY=tines_… tines runner install --name laptop --harness claude-code
```

registers this machine as a local runner and installs the daemon as a launchd/systemd
service that polls for work and keeps itself updated (`tines runner daemon` with the same
flags runs it in the foreground instead). See
[docs/runner-daemon.md](https://github.com/tbuckley/tines/blob/main/docs/runner-daemon.md)
for the flags, token rotation, and what the service does.
