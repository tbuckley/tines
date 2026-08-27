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
| `--max-concurrent` | Simultaneous runs on this machine | 1 |
| `--poll-interval` | Seconds between polls | 15 |

Each run's workspace (under the config dir) contains `prompt.md` (supervisor preamble +
stitched context + issue block), `skills/<name>/…`, `repos.json`, and a clone of each listed
repository made with the machine's own git credentials. The harness runs with
`TINES_API_KEY` set to the run's ephemeral key and `TINES_API_URL` set to the API base.

Rotating a token: `tines runners rotate-token <name>` invalidates the old token and prints
the new one once. Run it on the daemon machine and the stored token is updated in place —
just restart the daemon; elsewhere, the daemon exits with a clear 401 message until the new
token is dropped into its config.

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
  state file, reports their runs failed, and removes their workspaces. The supervisor also
  fails `running` runs missing from the daemon's `owned_runs` report, and fails everything
  after 5 minutes offline.
- **Ctrl-C / SIGTERM**: in-flight runs are killed and finish-reported as failed before exit.
- **Cancel / timeout from the supervisor**: the next poll's `cancels` list makes the daemon
  kill the process without reporting — the supervisor already settled the run. The daemon
  also enforces the run timeout locally.
- **Network errors**: polls retry with backoff; the loop never crashes. A 401 (rotated
  token) exits with instructions instead of spinning.
