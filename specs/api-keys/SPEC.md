# API key permissions

## 2026-09-23 — Run-key context reads (Tines/719)

Run keys may read an issue's effective context with project and workspace read authority, and its launch or resume prompt with additional control-plane read authority. Reads remain limited to the run project by the run ceiling and to any narrower stored project policy. Other issues in that project remain readable when the stored policy permits them. The `issueScoped` marker applies only to context create, update, append, and delete: each mutation must be anchored to the run's assigned issue, including both old and new scopes on an update. A read never needs that mutation marker.

## 2026-09-21 — Explicit three-domain authority (Tines/648)

API keys store a versioned policy with independent project, workspace, and control-plane domains. Levels are cumulative (`none < read < write < delete`); projects additionally carry either `all` or an explicit ID set. Existing rows and old-worker inserts receive the explicit full-authority database default. Invalid stored policies fail authentication closed.

Authorization is semantic and happens after resolving the operation's targets. A mixed operation must satisfy every domain it affects before any write. Project collections are filtered before pagination; exact out-of-scope resources remain indistinguishable from missing resources. Irreversible removal requires `delete`; reversible archive, unlink, and unassign operations remain `write`.

Key management is control-plane authority. Metadata reads require control-plane read, create/update require write, and revoke requires delete. A key-authenticated manager may delegate only a subset of its effective authority. Permission replacement uses an expected-policy compare-and-swap and records canonical before/after policies in `api_key.permissions_updated`; secrets and hashes never enter events.

Run keys use the same stored policy plus an independent `run-v1` ceiling. Authentication requires a live, consistently bound run. Project access is confined to the run project, existing-issue writes to the bound issue, and only named semantic operations are allowed. The exact launch-state-root journal create/append/rewrite is the sole workspace-write exception. Over-granting stored permissions never widens this ceiling; under-granting still denies.

Issuing a runner token or changing an execution credential/destination delegates future project work. It therefore requires project write on all projects, workspace write, and control-plane write. Public links, runner-token protocol calls, and host moderation retain their dedicated authentication boundaries.

Migrations precede worker deployment. Rolling back to code that ignores the column would over-authorize scoped keys; revoke non-full and active run keys before such a rollback, then restore enforcement before replacing them.
