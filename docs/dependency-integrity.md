# Dependency graph integrity

Issue links stored as `blocks` and `duplicate_of` form one directed graph per account. `blocked_by` is only an input alias and is stored as a reversed `blocks` edge. Since the 2026-09-11 concurrency amendment, the link API preserves acyclicity at commit time: a recursive `UNION` reachability query and the conditional insert run in one D1 batch, followed by two link-ID-guarded events, a receipt, and a cycle-diagnostic snapshot. D1 executes batch statements sequentially in one transaction and rolls the whole batch back when any statement fails.

The guard has five statements. Each has a fixed number of bindings independent of graph size and remains below D1's 100-bound-parameter and 100,000-byte SQL limits. Reachability carries only issue IDs and uses `UNION`, so it terminates even if a historical cycle exists. There is no depth cutoff and no fail-open path. A failed D1 statement returns an error and rolls back the link and events. A valid concurrent edit does not need a retry; an edit that closes a path gets `422 link_cycle` with the closed canonical-ref path captured by its transaction. Retrying after a removal is safe and is evaluated against the then-current graph.

This guarantee covers all link creation through the deployed API. Direct administrative SQL and an older deployment still in flight can bypass it. Rolling back to code predating the amendment removes the concurrency protection. Link removals and FK cascades only remove edges and cannot create cycles; same-account project transfer preserves issue IDs and edges.

## Read-only legacy-cycle audit

For an API-only best-effort audit, page `GET /api/v1/issues?archived=all&brief=1&limit=100` until `next_cursor` is null, then fetch every issue detail. Collect `links.blocks` and `links.duplicate_of`, deduplicate by link ID, and run a strongly-connected-components algorithm. Report every component larger than one and every self-loop with link ID, kind, endpoint IDs and canonical refs. Also report page/detail request failures, missing endpoints and total issue/link counts. Never call an incomplete inventory clean. API pagination is not a consistent snapshot during writes, so rerun during a stable period.

With authorized read-only D1 access, this account-scoped query gives a consistent reachability audit. It mutates nothing:

```sql
WITH RECURSIVE graph(user_id, origin, node) AS (
  SELECT sp.user_id, l.source_issue_id, l.target_issue_id
  FROM issue_link l
  JOIN issue s ON s.id = l.source_issue_id
  JOIN project sp ON sp.id = s.project_id
  JOIN issue t ON t.id = l.target_issue_id
  JOIN project tp ON tp.id = t.project_id
  WHERE l.kind IN ('blocks', 'duplicate_of') AND sp.user_id = tp.user_id
  UNION
  SELECT graph.user_id, graph.origin, l.target_issue_id
  FROM graph
  JOIN issue_link l ON l.source_issue_id = graph.node
  JOIN issue t ON t.id = l.target_issue_id
  JOIN project tp ON tp.id = t.project_id AND tp.user_id = graph.user_id
  WHERE l.kind IN ('blocks', 'duplicate_of')
)
SELECT user_id, origin FROM graph WHERE origin = node ORDER BY user_id, origin;
```

Run it for every account before making a deployment-wide claim. The research audit at `2026-09-11T17:06:39Z` covered 556 issues and 134 links (all `blocks`) and found zero cyclic components. This dated result is not a substitute for the post-deploy audit.

If an audit finds a legacy cycle, attach the complete report and open an operator remediation issue. Do not silently delete or rewrite links. Operator-approved removal should use the normal API so both activity events remain intact.

## Native verification

The implementation gate was run on 2026-09-11 on arm64 macOS with Node 26.2.0, Wrangler 4.130.0, Miniflare 5.20260908.0-alpha and workerd 1.20260908.1. The command is:

```sh
pnpm --filter @tines/web exec playwright test e2e/native-links.spec.ts
```

The native suite sends requests through the built worker and inspects the local D1 store independently with `wrangler d1 execute --local --persist-to .wrangler-e2e`. It runs 20 fresh pairs for each reciprocal-block, duplicate-only, mixed, and `blocked_by` alias race, alternating which of two API keys launches first. Each iteration requires one `201`, one `422 link_cycle`, an acyclic one-edge graph, no losing event, and two winning events with the same link ID, opposing roles, correct peer metadata/project, and the winning API-key actor. Both sequential orders are controls. Separate cases cover the disjoint four-node closure, two concurrent valid additions, exact duplicates, second-canonical duplicates, and direct graph/event/actor audits.

The real POST route was also run with a local D1 trigger forcing the target event statement to fail. D1 returned `SQLITE_CONSTRAINT_TRIGGER`; the independently read store contained neither the earlier inserted link nor either event, proving later-statement rollback for the real five-statement builder.

The large-graph gate seeds a 1,001-node/1,000-edge chain and a 1,002-node/2,000-edge converging fan-out. It exercises both a valid insertion and a rejected cycle through the real API for each graph, requires the complete 1,002-step chain diagnostic and four-step fan-out diagnostic, and prints request timings and diagnostic sizes in the test output. On the environment above the whole four-request/plan test completed in 1.6 seconds. `EXPLAIN QUERY PLAN` reported `SEARCH link USING COVERING INDEX sqlite_autoindex_issue_link_2 (source_issue_id=?)` for the recursive expansion. Each builder statement has a graph-size-independent binding count below D1's 100-parameter limit and SQL text below 100,000 bytes; large fixture setup is deliberately chunked because these platform statement limits also apply to test seeding.

Run this gate before release and retain its printed evidence in CI. A later-statement failure must leave no link or event. Failure of the native race, traversal, plan, or rollback checks requires redesign rather than weakening or capping the traversal.
