# API key permissions

## 2026-09-26 — Contributor-bound run keys (Tines/751)

A run key is bound at authentication to its contributor (`agent_run.user_id`), runner, admitted project, the issue's project assignment token, and, for a member run, the membership revision it was admitted at (`agent_run.admitted_membership_revision`, migration `0049`). Authentication fails closed with `401 run_key_inactive` and a `reason`: `contributor_mismatch` (key or runner owner is not the contributor), `cancel_requested` (owner runs too — cancellation revokes app capability immediately, the slot stays occupied until the terminal acknowledgement), `transferred` (issue left the admitted project or its token changed), `membership_changed` (project unshared, member removed, rejoined at a new revision, or no admitted revision recorded), and `owner_changed`.

A member run resolves project data only for its admitted project, through the owner-scoped data view built from the immutable binding; everywhere else, and for every account-level route, it resolves the contributor's own account. The authenticated actor, key, run, runner, usage and event `actor_user_id` stay the contributor's. The run-v1 ceiling, stored policy and member fences are unchanged.

Every run-reachable write re-checks the binding in the same D1 batch (`runStillBoundPredicate`): live run with no cancellation request, the live unexpired unrevoked key, the issue still in the admitted project with the same token, and the contributor still the owner or a current member at the bound revision. A request authenticated before cancel, expiry, revocation, removal or transfer cannot commit. Off, hold and archive do not revoke; the run drains.

`GET /issues/:id/journal` resolves the journal anchor before authorizing, so a run key's read uses the same bound-journal resolution as its writes.

An issue a run key files in a shared project is created with the project owner's agents off; a person must allow it in the browser.

## 2026-09-23 — Run-key context reads (Tines/719)

Run keys may read an issue's effective context with project and workspace read authority, and its launch or resume prompt with additional control-plane read authority. Reads remain limited to the run project by the run ceiling and to any narrower stored project policy. Other issues in that project remain readable when the stored policy permits them. The `issueScoped` marker applies only to context create, update, append, and delete: each mutation must be anchored to the run's assigned issue, including both old and new scopes on an update. A read never needs that mutation marker.

## 2026-09-21 — Explicit three-domain authority (Tines/648)

API keys store a versioned policy with independent project, workspace, and control-plane domains. Levels are cumulative (`none < read < write < delete`); projects additionally carry either `all` or an explicit ID set. Existing rows and old-worker inserts receive the explicit full-authority database default. Invalid stored policies fail authentication closed.

Authorization is semantic and happens after resolving the operation's targets. A mixed operation must satisfy every domain it affects before any write. Project collections are filtered before pagination; exact out-of-scope resources remain indistinguishable from missing resources. Irreversible removal requires `delete`; reversible archive, unlink, and unassign operations remain `write`.

Key management is control-plane authority. Metadata reads require control-plane read, create/update require write, and revoke requires delete. A key-authenticated manager may delegate only a subset of its effective authority. Permission replacement uses an expected-policy compare-and-swap and records canonical before/after policies in `api_key.permissions_updated`; secrets and hashes never enter events.

Run keys use the same stored policy plus an independent `run-v1` ceiling. Authentication requires a live, consistently bound run. Project access is confined to the run project, existing-issue writes to the bound issue, and only named semantic operations are allowed. The exact launch-state-root journal create/append/rewrite is the sole workspace-write exception. Over-granting stored permissions never widens this ceiling; under-granting still denies.

Issuing a runner token or changing an execution credential/destination delegates future project work. It therefore requires project write on all projects, workspace write, and control-plane write. Public links, runner-token protocol calls, and host moderation retain their dedicated authentication boundaries.

Migrations precede worker deployment. Rolling back to code that ignores the column would over-authorize scoped keys; revoke non-full and active run keys before such a rollback, then restore enforcement before replacing them.
