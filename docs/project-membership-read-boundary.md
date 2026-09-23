# Shared project membership and read boundary

Inviting a person converts a project to consent mode. The owner must acknowledge that existing issue and schedule permissions start empty and unlaunched assigned work will wait. The conversion and invitation record commit in one D1 batch. A competing first invite retries against the converted project without repeating that conversion. Email is sent only after the winning receipt. Delivery failure leaves the invitation saved with `delivery_status: failed`; resend rotates its token.

An invitation stores a hash of a random token, not the token. The link expires after seven days and binds acceptance to the current user's verified email. Only a browser session can accept. A wrong account must switch or sign in through the link's same-origin return path. Replaced, canceled and revoked links cannot rejoin a person. An accepted link is idempotent only while the same membership revision remains active.

## Addressing and capabilities

- Project and issue reads resolve the actual actor. A run key cannot use its user's memberships as human authority. An inaccessible target returns 404. Member writes remain disabled except acceptance and self-leave; the owner can invite, resend, cancel and remove.
- Immutable project IDs and issue IDs are the reliable addresses. A project name is resolved only among projects readable by the caller; duplicate readable names return an ambiguity error with those project IDs. Issue numbers use `issue_address` within a resolved project, including historical aliases.
- Project, issue, schedule, artifact and activity lists expose only current memberships. Cursor reads order by creation time and ID. Each member projection uses an explicit field list and checks the membership revision again before returning.
- A member issue page chooses its restricted projection before loading owner context, runner, routing, usage or account data. The project page uses the same boundary. Restricted pages and CLI reads describe the owner, workflow, current state, roster and read-only work without execution guidance.

## Data that crosses the boundary

Members can read project and issue summaries, comments, labels, visible links, workflow definitions used by their projects (states and transitions only), schedule summaries, artifact metadata and versions, and authenticated artifact downloads. Inaccessible link targets are omitted; a hidden blocker becomes a generic blocked flag. HTML artifacts download as attachments; member requests cannot mint a public site link.

Member activity is an explicit type allowlist with empty event payloads and current issue/project references. Only `context.*` events whose kind is `artifact` enter that feed. Unknown types, private context, prompt, journal, account, run detail, credential, routing and usage data are outside the member projection. A removal tombstones the membership revision, clears that person's choices, revokes their project run keys and records cancellation intent for their active project work. A read still in flight checks the revision again and discards its response if removal wins.

This read boundary does not enable member comments, decisions, personal permission changes or agent execution. Those controls belong to the next implementation slice.

## Verification entry points

`apps/web/e2e/project-membership.spec.ts` covers the two-account join/read flow, sign-in return, wrong account, token replacement and expiry, artifact versions, CLI reads and privacy canaries. `apps/web/e2e/native-collaboration.spec.ts` covers conversion and removal ordering against native D1. `apps/web/src/lib/server/api/invitations.test.ts` covers token and capability rules in a direct service fixture.
