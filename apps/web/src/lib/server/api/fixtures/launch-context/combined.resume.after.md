## Issue: Fixture Project's/520 — Keep essential launch context

Preserve the durable human decision while making older agent detail recoverable.

### Current state

Implementation (active), in workflow "Engineering".

Labels: performance

Label it: `tines issues label Fixture Project's/520 <name...>` (existing labels only: performance, qa)

### Comments

**Fixture Human** (2023-11-14T22:13:20.000Z, ID: cmt_human):
Human decision: keep exact current bodies available.

**Fixture Human via fixture-runner · run on Fixture Project/520** (2023-11-14T22:13:22.000Z, ID: cmt_handoff):
Completed same-issue handoff: implementation is ready.

**Fixture Human via fixture-runner · run on Fixture Project/999** (2023-11-14T22:13:23.000Z, ID: cmt_cross_1):
Newer cross-issue update one.

**Fixture Human via fixture-runner · run on Fixture Project/999** (2023-11-14T22:13:24.000Z, ID: cmt_cross_2):
Newer cross-issue update two.

**Fixture Human via fixture-runner · run on Fixture Project/999** (2023-11-14T22:13:25.000Z, ID: cmt_cross_3):
Newer cross-issue update three.

Older agent comments: cmt_old_detail, cmt_old_test, cmt_old_docs, cmt_old_review, cmt_old_followup. Load one (change --arg id to a listed ID): `tines issues show 'Fixture Project'\''s/520' --json | jq -er --arg id cmt_old_detail 'first(.comments[] | select(.id == $id) | .body) // error("comment not found: \($id)")'`. Without jq / for full history: `tines issues show 'Fixture Project'\''s/520'`.

Add a comment (the quoted heredoc keeps backticks, $VARS and quotes literal):
```
tines issues comment Fixture Project's/520 - <<'EOF'
<markdown>
EOF
```
A `tines` too old for that form posts a literal `-` instead of your body, without failing. If `tines issues comment --help` does not mention `@file`, use `tines issues comment Fixture Project's/520 "<markdown>"` and mind the shell quoting.
Fix your own mis-post rather than leaving it in the thread: `tines issues comment-edit Fixture Project's/520 <comment-id> -` (same body forms) replaces a body, `tines issues comment-delete Fixture Project's/520 <comment-id>` removes it. Ids are echoed when you post and listed by `tines issues show Fixture Project's/520 --json`; you can only edit or delete comments you wrote.

### Artifacts

- **design-doc** (text, text/markdown, v1, fresh)
  Fetch: `tines issues artifacts get Fixture Project's/520 design-doc --out .`

Attach one: `tines issues artifacts attach Fixture Project's/520 <name> …` — the source follows the gate; each gated transition below names its exact command. Ungated slots: --file <path>, --folder <dir>, --text <md|@file>, --link <url>, --pr <owner/repo#N>.
An HTML file (or a folder with a root index.html) renders live as a prototype — keep all CSS/JS inline (external CDNs are blocked), add `<meta name="viewport" content="width=device-width, initial-scale=1">`, and `tines issues artifacts site-link Fixture Project's/520 <name>` mints a URL to see it.

### Available transitions

None — this state is terminal.

### Journal

No journal exists yet for project Fixture Project's · state Implementation. Start one:
`tines journal append Fixture Project's/520 "- <date>: <lesson>"`
(or `-` with a quoted heredoc, as for comments, when the body must not be touched by the shell)

### Skills

- Skill "fixture-skill" (global): read `skills/fixture-skill/SKILL.md` when this applies: Use when comparing launch-context selection and recovery behavior.

If a skill path is unavailable, read its files with `tines issues context Fixture Project's/520 --json`; to write the bundle into a new directory, use `tines issues context Fixture Project's/520 --out <dir>`.