# Tines — Issue Dependencies & Duplicates Spec

Work has structure: a migration can't ship before its schema review closes, and the same bug gets filed twice. **Issue links** let the tracker capture both. A *blocking* link declares that one issue must close before another is really actionable; a *duplicate* link folds an issue into its canonical twin so its state simply follows along. Together they answer the question agents and humans actually ask the tracker: *what is ready to work on right now?*

Links are advisory, not gates — a blocked issue can still be started or closed deliberately. What links change is visibility: readiness, badges, and a `ready` filter that lists only actionable issues.

## Goals

- **Blocking links**: declare that issue A blocks issue B (equivalently, B is blocked on A), many-to-many, across projects.
- **Duplicate links**: mark an issue as a duplicate of another; the duplicate's *effective* state passes through to the canonical issue's state transitively, with no state writes.
- **Readiness**: an issue is **ready** when it is not effectively done, is not a duplicate, and every one of its blockers is effectively done. A `ready` filter composes with all existing list filters.
- **Cycle prevention**: blocking and duplicate edges form one directed graph; any link that would create a cycle is rejected.
- Full support in the API, shared types, CLI, and web UI, with links recorded in both issues' activity feeds.

## Non-goals

- **Enforcement**: no transition is ever refused because of a link. Blocking is advisory only; workflows and the transition CAS logic are untouched.
- **State merging on duplicate**: marking a duplicate copies nothing — no comments, no description merge, no state write. Un-marking restores the issue's own state simply because that state never changed.
- **Other relation kinds**: no "relates to", no parent/child, no epics. The schema leaves room (a `kind` column) but only `blocks` and `duplicate_of` exist.
- **A `blocked` filter**: only `ready` ships now; a symmetric "show blocked" filter is an easy follow-up.
- **Cross-user links**: everything remains user-scoped; you can only link issues you own (cross-project is fine, cross-user is a 404 like every other cross-user reference).
- **Bulk operations**: links are created and removed one at a time.

## Concepts

### Links

A directed edge between two issues owned by the same user, with a kind:

- **`blocks`**: `source blocks target` — the target is *blocked on* the source. Many-to-many: an issue can block many issues and be blocked by many.
- **`duplicate_of`**: `source is a duplicate of target` — the target is the canonical issue. At most **one** outgoing `duplicate_of` edge per issue; chains are allowed (A → B → C) and resolve transitively to the terminus.

Both kinds may cross project boundaries. Removing a link is symmetric with adding it and emits the mirror event.

### The combined graph and cycles

Both kinds orient the same way (source → target) and live in one directed graph. **Any link whose addition would create a directed cycle in that graph is rejected with a 422 naming the path** — this covers self-links, `A blocks B / B blocks A`, duplicate loops, and mixed loops like `A blocks B / B duplicate_of A`. The check walks the existing graph from the new target looking for the new source (depth-first over both kinds).

Reads stay defensive anyway: every traversal (duplicate resolution, readiness, cycle check itself) keeps a visited set and a depth cap, so even a cycle racing in through concurrent writes degrades to "resolution stops at the repeat" rather than a hung query. With a single-user tracker this is a belt-and-suspenders guard, not an expected path.

#### 2026-09-11 concurrency amendment (Tines/453)

The preceding tolerance for a theoretical concurrent-write race is superseded. Acyclicity is a commit-time invariant for API-created links, including concurrent additions with disjoint endpoint pairs. The authoritative `INSERT` performs account-scoped recursive reachability inside the same D1 batch as the link and its two events. Events are conditional on that request's fresh link ID. A skipped insert is classified from an in-batch receipt; cycle diagnostics use an in-batch edge/ref snapshot, so the losing request reports the canonical closed path even if a later removal changes the graph. Concurrent additions whose union remains acyclic both commit; no graph revision or logical retry is involved. Defensive read caps and visited sets remain for legacy or out-of-band corruption.

### Effective state (duplicate passthrough)

An issue's **effective state** is its own state unless it has a `duplicate_of` edge, in which case it is the effective state of its canonical issue — i.e. the state of the duplicate chain's terminus. Because chains are acyclic and each issue has at most one outgoing duplicate edge, the terminus is unique.

- The duplicate keeps its own `state_id` in the database; nothing is written when the canonical issue moves. Closing the canonical issue effectively closes every transitive duplicate at read time; reopening it effectively reopens them.
- Issues may sit in different workflows, so the passthrough is the canonical issue's *state* (name + category), not a mapped local state. Lists and filters show and match the effective state; the detail view shows the effective state prominently with the issue's own dormant state alongside ("duplicate of demo/12 — showing its state").
- **All list read paths resolve through duplicates**: the `state`, `category`, and `hide_done` filters match the effective state, and issue rows render it (with a duplicate badge). Transitions still operate on the issue's own state — allowed, but they don't change what's displayed while the duplicate link exists (the UI de-emphasizes transition controls on duplicates).
- A blocker that is itself a duplicate counts by its effective category too: if A blocks B and A is a duplicate of D, then B is unblocked exactly when D is done.

### Readiness

```
ready(I) =  effective_category(I) != 'done'
        AND I has no duplicate_of edge
        AND every J with (J blocks I): effective_category(J) == 'done'
```

An issue with no blockers and no duplicate link is ready whenever it isn't done — readiness is the default condition, links only take it away. `ready=true` is a list filter that composes with everything existing (`project`, `state`, `category`, `workflow`, `schedule`), so "ready issues matching a query" is just the existing query plus `ready`.

### Events

New event types (open string types, no migration needed), written to **both** endpoint issues' feeds so either activity log tells the story:

- `issue.link_added` / `issue.link_removed` — payload: `{ kind, role: 'source' | 'target', other_issue_id, other_project_name, other_number, other_title }` (role is from the perspective of the issue the event row belongs to).

The UI renders these as "marked as blocking demo/14", "marked as a duplicate of web/3", "unmarked …", etc.

## Data model (D1 / Kysely)

One new table, in a new numbered migration (`0008_issue_links.sql`), plus a matching `IssueLinkTable` interface registered in `db.ts` (`lnk_` id prefix via `newId`):

```
issue_link  id, source_issue_id, target_issue_id, kind, created_at
            -- kind CHECK (kind IN ('blocks', 'duplicate_of'))
            -- FK both columns → issue(id) ON DELETE CASCADE
            -- CHECK (source_issue_id != target_issue_id)
            -- UNIQUE (source_issue_id, target_issue_id, kind)
            -- partial UNIQUE on (source_issue_id) WHERE kind = 'duplicate_of'
            -- indexes on source_issue_id and target_issue_id
```

Notes:

- The partial unique index is what enforces "one canonical issue per duplicate" at the storage layer; the API turns that violation into a 422 telling you to unmark the existing duplicate first (the generic UNIQUE→409 path covers double-adding the same link).
- Guarded cycle check + insert + both event rows, receipt and diagnostic snapshot execute sequentially in one transactional D1 `batch` via `runAtomic`. This is the commit-time concurrency boundary described in the 2026-09-11 amendment above.
- Effective state and readiness are computed per query with a recursive CTE over `issue_link` (depth-capped), hung off the existing `issueQuery` base so user-scoping stays in one place. No denormalized "blocked" flag — D1 volumes here are small and the CTE keeps reads consistent by construction.
- Issues are not deletable today; `ON DELETE CASCADE` future-proofs the links if that changes.

## API

Same conventions as phase one: `/api/v1/*`, session or bearer key, user-scoped (cross-user = 404), structured 422s. Shared types in `@tines/shared`.

| Method & path | Purpose |
| --- | --- |
| `POST /api/v1/issues/:id/links` | Add a link. Body: `{ kind: 'blocks' \| 'blocked_by' \| 'duplicate_of', issue_id }`. `blocked_by` is sugar: it creates a `blocks` edge in the other direction so callers never have to reason about orientation. Returns the created link |
| `DELETE /api/v1/issues/:id/links/:linkId` | Remove a link (either endpoint's id works as `:id`) |
| `GET /api/v1/issues/:id` | `IssueDetail` gains a `links` object (below) and `effective_state` |
| `GET /api/v1/issues` (+ project-scoped list) | New filter `ready=true`; rows gain `effective_state`, `open_blockers` (refs of effectively-open blockers: `{ project_name, number, title }`), and `duplicate_of` (ref of the direct canonical issue, or null) so lists can badge — and tooltip the blockers by name — without extra requests |

`IssueDetail.links`, everything pre-joined for display (each entry: `{ link_id, issue_id, project_name, number, title, effective_state }`):

```ts
links: {
	blocks: LinkedIssue[];        // issues this one blocks
	blocked_by: LinkedIssue[];    // issues blocking this one
	duplicate_of: LinkedIssue | null;   // canonical issue (direct edge, not the chain terminus)
	duplicated_by: LinkedIssue[]; // issues marked as duplicates of this one
}
```

`effective_state` on both `Issue` and `LinkedIssue` is a `WorkflowState` — for non-duplicates it equals `state`; for duplicates it is the chain terminus's state.

Validation (422 with specifics): cycle (details include the path as `project/number` refs); second `duplicate_of` edge; unknown kind; linking an issue to itself. 404 for a target issue that doesn't exist or isn't yours; 409 for an exact-duplicate link row.

## CLI

Four new `issues` subcommands plus a flag, all using the existing `<project>/<number>` refs and `resolveIssue`:

```
tines issues block <blocker> <blocked>      # "demo/3 blocks demo/7"
tines issues unblock <blocker> <blocked>
tines issues duplicate <ref> <canonical>    # alias: dupe — "web/9 is a duplicate of demo/3"
tines issues unduplicate <ref>              # alias: undupe — removes the duplicate_of edge
tines issues list [--ready] [...existing flags]
```

Argument order reads as the sentence: `block A B` means *A blocks B*. `unblock`/`unduplicate` resolve the link to remove themselves — no link ids at the CLI surface.

`issues show` gains sections after the state line, each entry showing ref, title, and effective state:

```
Blocked by   demo/3   Fix schema review        active   ← why this isn't ready
Blocks       demo/9   Ship the migration       backlog
Duplicate of web/3    Login button dead        done     (state shown above is web/3's)
Duplicates   demo/11  Login broken on mobile
```

`issues list` marks blocked rows and duplicates in the table (a `blocked`/`dup` marker column) and `--json` carries `effective_state`, `open_blockers`, and `duplicate_of` per row. All new commands support `--json`.

## Web UI

Follows the phase-one look and feel throughout: shadcn-svelte primitives, Tabler icons (deep imports), meaningful motion only (slide/fade at ~180–220ms, FLIP in lists, `prefers-reduced-motion` respected), optimistic updates with rollback on API rejection, and the existing error-banner pattern on the detail page. Two icons carry the feature everywhere they appear: **`IconBan`** for blocked, **`IconCopy`** for duplicates — used consistently in list rows, badges, banners, and activity events so the two concepts stay visually distinct.

### Issue rows (everywhere `IssueList` renders — Issues tab, project pages)

- The `StateBadge` shows the **effective** state, keeping its shared-element view-transition to the detail page. For a duplicate this is the canonical issue's state — a row's badge can therefore show a state name from another workflow; the category color makes it read correctly regardless.
- **Blocked marker**: an issue with ≥ 1 effectively-open blocker gets a small amber chip after the title — `IconBan` plus the open-blocker count (e.g. `⃠ 2`) — styled like the existing schedule repeat chip. Its tooltip lists the open blockers by ref and title ("Blocked by demo/3 — Fix schema review; web/5 — …"). The chip is informational, not a nested link (the row already navigates); it disappears — with the row's usual transition, no snap — once the last blocker effectively closes.
- **Duplicate marker**: a duplicate gets a muted `IconCopy` chip labeled `dup`, tooltip "Duplicate of demo/3 — *Login button dead*". Duplicate rows render slightly muted overall (like paused schedule rows) to signal "this is not where the work is".
- Both markers derive from the `open_blockers` / `duplicate_of` fields the list API now returns — no extra requests.

### Issues tab — Ready filter

- A **Ready only** checkbox in the filter bar, next to "Show done", wired to the `ready` URL param (round-trips like every other filter) and composing with project/state/category.
- Ready implies not-done, so while it's checked the "Show done" checkbox is unchecked and disabled (tooltip: "Ready issues are never done"). Unchecking Ready restores it.
- The empty state reads "No ready issues match these filters." so it's obvious the readiness constraint (not the query) may be what emptied the list.
- The project detail page reuses `IssueList`, so markers appear there automatically; its issue section gains the same Ready checkbox alongside its existing controls.

### Issue detail — header

- The header badge shows the **effective** state (it is the target of the list's shared-element morph, so list and detail always agree).
- On a duplicate, a `dup` tag sits on the badge and a one-line banner renders directly under the header row, `IconCopy` first:
  > *Duplicate of **demo/3** — Login button dead. This issue's state follows it.*  … [Not a duplicate?]
  The ref links to the canonical issue; **Not a duplicate?** removes the `duplicate_of` link in place (optimistic — the banner slides away, the badge morphs back to the issue's own state, rollback on failure). For a chain, the banner names the *direct* canonical issue but the badge shows the *terminus* state; hovering the badge tooltips the resolution ("via demo/3 → web/1").
- On a blocked issue, an amber `IconBan` chip ("Blocked · 2") sits beside the badge; clicking it scrolls to the Relations section. No banner — blocking is advisory and shouldn't shout.

### Issue detail — Relations section

A new card in the sidebar, between **State** and **Activity** (the same `rounded-lg border p-4` section styling). Always rendered — its header row is `Relations` plus a ghost **+ Add** button; with no links the body is just a hint line ("Link issues that block this one, or mark it a duplicate.").

- **Readiness line**: when the issue has blockers, the first line summarizes: green-dot "Ready — all blockers closed" or amber-dot "Not ready — 2 of 3 blockers open". This is the UI's one-glance answer to "why isn't this ready?".
- **Four groups**, in this order, each with a small uppercase label and hidden when empty: **Blocked by**, **Blocks**, **Duplicate of**, **Duplicated by**. Group order puts "what's stopping this" first.
- **Rows** are compact (the sidebar is 22rem): category-colored state dot (tooltip: effective state name), mono `project/#number` ref, truncated title. The whole row links to that issue. Effectively-open entries under *Blocked by* render at full strength; effectively-done ones dim — so open blockers pop. A **×** on the right removes the link (always visible on touch screens; revealed on hover where a fine pointer exists): optimistic (row slides out per the motion rules), rollback + error banner on failure, no confirm dialog — links are cheap to re-add and the removal is recorded in both activity feeds anyway.
- **Adding**: **+ Add** reveals an inline two-control form (slide transition): a kind `Select` — *Blocked by* / *Blocks* / *Duplicate of* (the API's `blocked_by` sugar means the UI never exposes edge orientation) — and an **autocomplete issue picker**. The picker is a combobox: it fetches the user's issues once through the existing list API when the form opens and filters client-side as you type (fine at single-user volumes; a server-side `q` search is the upgrade path if that fetch ever gets heavy), matching case-insensitive substrings of both the `project/number` ref and the title. Suggestion rows mirror the Relations row anatomy — mono ref, truncated title, state-category dot. Open issues rank first; done issues are included but sorted below and dimmed (pointless as blockers, essential for duplicates of already-fixed issues); the issue itself and already-linked issues are omitted. An empty input shows the most recently active issues. Arrow keys navigate, Enter or click adds immediately (no separate confirm) — the new row slides into its group, and the input clears but keeps focus so several blockers can be added in a row.
- **Inline rejections**: a 422 renders under the form, not in the page banner. A cycle shows the path as linked refs ("would create a cycle: demo/7 → demo/3 → demo/7"); a second `duplicate_of` shows "Already a duplicate of demo/3 — remove that link first" with the ref linked. The form stays open with input preserved so the user can correct course.
- **Duplicate of** rows additionally note the resolved state when a chain is involved ("→ showing web/1's state").

### Issue detail — State section on a duplicate

Links are advisory, so nothing is hidden — but the section stops pretending to be the source of truth:

- A muted note at the top: "*This issue is a duplicate — its displayed state follows demo/3.*" (ref linked).
- The workflow graph still highlights the issue's **own** (dormant) state, and transition buttons still work against it — moving a duplicate is allowed, it just doesn't change what lists display while the link exists. The section renders slightly muted (same treatment as duplicate list rows) to make that hierarchy visible.
- Removing the duplicate link restores full emphasis with a fade — and since the state never changed, the graph and buttons are already correct.

### Activity feeds

`issue.link_added` / `issue.link_removed` render on **both** issues' feeds (and the global Activity tab) as human sentences from the owning issue's perspective, with the other issue's ref linked and the kind's icon shown — actor attribution as everywhere else:

- "**alice** marked this as blocking **demo/14** — *Ship the migration*"
- "**my-agent** marked this as blocked by **web/5**"
- "**alice** marked this as a duplicate of **demo/3**" / "…unmarked…"

State-change passthrough is virtual, so closing a canonical issue emits no events on its duplicates — the feed records link changes and real transitions only.

### Out of scope for the UI pass

No links at creation time (the New Issue modal is untouched — link after creating), no dependency graph visualization, no drag-to-link. All are natural follow-ups once the Relations card exists.

## Acceptance criteria

1. `tines issues block demo/3 demo/7`: `demo/7` shows "Blocked by demo/3" in `issues show` and the web detail page, `issues list --ready` omits `demo/7`, and both issues' feeds record the link. Closing `demo/3` makes `demo/7` ready with no further writes.
2. `tines issues duplicate web/9 demo/3`: `web/9` lists and displays with `demo/3`'s state everywhere; closing `demo/3` effectively closes `web/9` (it disappears from `ready` and from default `hide_done` lists); `tines issues unduplicate web/9` restores its own (unchanged) state.
3. Chains resolve transitively: with `A duplicate_of B` and `B duplicate_of C`, A shows C's state; an issue blocked by A becomes ready exactly when C closes.
4. Cycles are rejected with a 422 naming the path, in all shapes: `demo/7 blocks demo/3` after (1), a duplicate loop, and the mixed case `B duplicate_of A` when A already blocks B. Marking a second `duplicate_of` on the same issue is rejected with a clear 422.
5. Blocking never prevents a transition: a blocked issue can be moved and closed normally through the existing transition endpoints and UI.
6. `ready=true` composes with existing filters: `tines issues list --ready -p demo -c backlog` returns exactly the backlog issues in `demo` with no open blockers and no duplicate link, and the web Ready toggle matches.
7. Cross-project links work end to end: `web/9 duplicate_of demo/3` and `cli/2 blocks web/5` behave identically to same-project links.

## Resolved questions

- **Duplicate semantics**: virtual passthrough. The duplicate keeps its own `state_id`; every read resolves effective state through the duplicate chain to the terminus. No state writes on mark, unmark, or canonical-issue transitions — cross-workflow mirroring problems never arise because nothing is mirrored, only displayed.
- **Readiness**: ready = own effective category ≠ `done`, not itself a duplicate, and all blockers effectively `done`. "What can I pick up right now", exposed as a `ready` filter composing with all existing filters.
- **Scope**: links may cross projects; user-scoping is the only boundary (cross-user = 404, as everywhere).
- **Cycles**: one combined directed graph over both edge kinds; any directed cycle — including mixed blocks/duplicate loops and self-links — is rejected at link-creation time with the offending path. Reads are defensively depth-capped regardless.
- **Enforcement**: advisory only. No transition is refused because of links; readiness, filters, and badges are the whole effect.
- **Storage**: one `issue_link` table (`blocks` | `duplicate_of`), source → target, with a partial unique index enforcing at most one canonical issue per duplicate. Effective state and readiness are computed per query via a recursive CTE; no denormalized flags.
- **Surfaces**: API + shared types, CLI (`block`, `unblock`, `duplicate`, `unduplicate`, `--ready`), and web UI (Relations section, badges, Ready toggle) all ship in the first pass.
