# tines

The command-line client for [Tines](https://github.com/tbuckley/tines), an issue tracker
built for humans and their agents: work moves through workflows, every action is on the
record, and a supervisor hands eligible issues to agents. This package talks to the same
HTTP API the web app uses.

```sh
npm install -g tines        # or, one-shot with no install:
npx -y tines --help
```

Node 20+. No runtime dependencies. Every push to the repository's `main` publishes a new
version, so `tines --version` always names the API it was built against.

## Pointing it at your Tines

```sh
tines login --url https://your-tines.example --api-key tines_…   # key: Settings → API keys
tines config                                                    # what is in effect, and from where
```

Or set `TINES_API_URL` and `TINES_API_KEY` in the environment — that is how agent runs are
configured, and the env vars win over the stored config. `--url` and `--api-key` on any
command win over both.

## Everyday commands

```sh
tines projects list
tines issues list --project <project>
tines issues create <project> --title "…" -d @description.md
tines issues show <project>/<number>
tines issues move <project>/<number> <action>        # a workflow transition
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
tines runner daemon --name laptop --harness claude-code
```

registers this machine as a local runner and polls for work. See
[docs/runner-daemon.md](https://github.com/tbuckley/tines/blob/main/docs/runner-daemon.md)
for the flags, token rotation, and keeping it running under launchd or systemd.
