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
stored config. On commands that talk to the API, `--url` and `--api-key` win over both. The
local-only `logout`, `packs validate`, `runner restart`, `runner uninstall`, `runner workspaces`,
and `runner workspaces prune` commands take no `--url`.

## Everyday commands

```sh
tines projects list
tines issues list --project <project>
tines issues create <project> --title "…" -d @description.md
tines issues create <project> --title "Linked" --blocked-by Other/12 --blocks Other/14 --duplicate-of Other/9
tines issues show <project>/<number>
tines issues move <project>/<number> <action>        # a workflow transition
tines issues move <project>/<number> <action> --expect-revision <n>   # refuse unless the issue is still at the decision revision `issues show` printed
tines issues hold <project>/<number>                 # stop new admission, keep permission
tines issues release <project>/<number>              # resume eligibility if permission remains on
tines issues cancel-run <project>/<number> <run-id>   # request bounded cancellation
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

`issues list` hides done issues and issues marked as duplicates by default. Use `--all` to include done issues and `--show-duplicates` to include duplicates; use both flags together when both populations are needed.

```sh
tines issues list --all --show-duplicates --all-pages --json
```

Issues are addressed as `<project>/<number>`; schedules as `<project>/<name>`; workflow
states as `<workflow>/<state>`. Paginated `list` commands return one page — add
`--all-pages` for the whole list. Six lists instead return the whole collection and take no
pagination flags: `labels list`, `runners list`, `routing list`, `api-keys list`,
`orgs list`, and `issues artifacts list`. Every leaf command except `login` and `logout` takes `--json` for
machine-readable output. Complete list walks have a default 10,000-item safety ceiling. Use
`--max-items <n>` with `--all-pages` to choose a different positive finite bound; exceeding
it fails without printing a partial result. `--limit` remains the per-request page size. A
larger bound keeps more output in memory and makes more requests, so increase it deliberately
or narrow the list's filters. `usage --evidence … --all-pages` is the one exception: it follows
every evidence page with no ceiling and takes no `--max-items`.
`tines <noun> --help` lists the rest: `api-keys`, `orgs`, `workflows`, `packs`, `labels`, `context`, `journal`,
`schedules`, `runners`, `runs`, `routing`, `supervisor`, `usage`.

`issues create` accepts repeatable `--blocked-by` and `--blocks` references plus one
`--duplicate-of` reference. The issue and all initial relationships are created atomically.
When a recurrence is also supplied, the relationships apply only to the first issue; later
scheduled instances start without copied relationships.

`workflows show` prints a workflow's `revision`, which advances by one on every committed
save. `workflows edit <workflow> … --expect-revision <n>` (or `"expected_revision"` in the
JSON body; the flag wins) refuses the update with `workflow_conflict`, writing nothing, when
the workflow is no longer at that revision. The CLI never fills the revision in for you and
never retries: re-read with `workflows show`, re-apply your change, and send the new revision.

For a shared project's recurring schedule, `schedules list` and `schedules show` report
your saved future-instance permission and its epoch. They are read receipts: the CLI and
API keys cannot turn personal permission on or off. Open the schedule in the browser to
choose. The first issue's permission is independent of the future schedule choice; future
permission starts off.

On a shared issue, `issues show` displays the safe member view. An accepted
member can use `issues comment`, repair their own human or run comment with
`comment-edit`/`comment-delete`, and use `issues move` from an awaiting-human
state. `issues move` submits the current exact decision witness once and does
not retry after a conflict. Keys cannot turn issue or future-schedule personal
permission on or off; open the issue or shared project in the browser. A saved
member choice does not enable member execution in this release.

## Organizations

Every account has a personal organization; a shared organization has an owner and managers,
and everyone in it works in every project in it. `<org>` is an organization id (`org_…`) or its
exact name among `tines orgs list`; a name two organizations share is refused with their ids.

```sh
tines orgs list                                  # name, kind, your role, owner, members, projects, id
tines orgs show Acme                             # people with roles and emails, pending invitations, projects
tines orgs create "Acme"
tines orgs rename Acme "Acme Inc"                # owner only
tines orgs invite Acme dee@example.com           # they accept from the emailed link, in the browser
tines orgs cancel-invite Acme <invite-id>
tines orgs remove Acme dee@example.com           # or a user id
tines orgs leave Acme --yes                      # managers; the owner transfers first
tines projects create Ops --org Acme --no-prompt
tines projects list --org Acme                   # every list row also names its organization
tines projects show Site --org Acme              # --org picks among projects with the same name
tines projects move Docs Acme                    # prints the move preview only
tines workflows create --file review.json --org Acme  # also: labels create --org, context create --org
tines api-keys create ci --preset full --org Acme --org Tom
```

Project names are unique within an organization, not across them: an ambiguous name is refused
with each project's id and organization, and the `projects` subcommands take `--org <org>` to
choose. `context create --org` is for items with no `--project` or `--issue` (those belong to the
project's organization), and is refused with either.

Some steps need your browser session, and the API refuses API keys for them:
`projects move` prints the preview (who gains and loses access, what happens to each workflow
and label, the organization context the project stops reading, and any blockers) and the page
to confirm it on; `projects share`, `orgs transfer` and `orgs delete` print where to do it and
exit 1. Accepting an invitation happens from its link.

A new API key reaches only your personal organization unless you pass `--org <org>`
(repeatable) or `--all-orgs`, which includes organizations you join later. A `--permissions`
policy is sent as written. `api-keys list` and `show` print each key's organizations; a key made
before organizations (policy version 1) shows `personal only`. Run scopes print `organization`
where older servers said `workspace`.

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

## Packs

A pack is a folder (or a zipped `.tinespack`) of workflows, the context that goes with them,
the inputs an installer supplies, and suggested schedules. `validate` runs offline, with the
same validator the server uses; the rest talk to the API. `<pack>` is the pack's row id, its
`pack.yaml` id, or its name when that is unique in the project.

```sh
tines packs validate ./engineering                  # errors, warnings, digest, summary (no server)
tines packs install ./engineering acme --dry-run    # print the review only
tines packs install ./engineering acme \
  --value staging_url=https://staging.acme.test \
  --repo app_repo=https://github.com/acme/app#main \
  --workflow bugs=pack:engineering/triage \
  --secret github_token --schedule weekly-triage@Europe/London --yes
tines packs install ./engineering acme --authored   # as an editable authored pack
tines packs sources acme                            # packs in your other projects
tines packs install --from <source-pack> acme
tines packs replace ./engineering acme <pack> --diff --map engineering/qa-check=engineering/review
tines packs replace --from-source acme <pack>
tines packs export acme <pack>                      # e.g. engineering-v4.tinespack, in the current folder
tines packs export acme <pack> --dir ./engineering  # or as files (refuses a non-empty folder without --force)
tines packs list acme
tines packs show acme <pack>
tines packs set-input acme <pack> staging_url https://staging.acme.test
tines packs set-secret acme <pack> github_token     # hidden prompt, or pipe the value on stdin
tines packs detach acme <pack>
tines packs remove acme <pack>                      # prints what is deleted and unbound first
```

Install and replace print the review (README, what the pack adds, replacements, inputs,
suggested schedules; for replace also the CHANGELOG, changed files, state mapping and version
warnings), then ask for confirmation on a terminal; elsewhere pass `--yes`. The confirmation
carries the reviewed digest, so the server refuses anything else. A workflow input takes a
workflow id or name (optionally `/<state>`), or `pack:<workflow>[/<state>]` for one of the
pack's own workflows. Missing inputs do not block: the pack is installed as *needs setup*.
A pack with a state whose `run_scope` is `project` or `organization` (or a replace that widens
one) can only be confirmed in the browser; the CLI stops before confirming and says so. A
lower version, or the same version with different content, needs `--confirm-version`.

## Running agents on your own machine

```sh
TINES_API_KEY=tines_… tines runner install --name laptop --harness claude-code
```

registers this machine as a local runner and installs the daemon as a launchd/systemd
service that polls for work and keeps itself updated (`tines runner daemon` with the same
flags runs it in the foreground instead). `--harness` is `claude-code`, `codex`, `pi` or
`custom`. See
[docs/runner-daemon.md](https://github.com/tbuckley/tines/blob/main/docs/runner-daemon.md)
for the flags, token rotation, and what the service does.
