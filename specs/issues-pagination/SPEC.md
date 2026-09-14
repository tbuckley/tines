# Issue list pagination

Issue lists in the web app use live, URL-backed keyset pages of 100 rows. The public API keeps its existing forward-only `cursor` contract documented in [phase 01](../phase_01/SPEC.md); web pages additionally support mutually exclusive opaque `after` and `before` boundaries.

Both `/issues` and `/projects/:id` render Previous and Next links. Filters remain in the URL and any filter change clears page boundaries. The global issues page includes a comparison-only `page_scope` marker so a changed project focus resets a bounded URL to its first page. Project pages derive scope from the path.

Rows are ordered by `(created_at DESC, id DESC)`. Forward queries use `<` and reverse queries use `>` with ascending SQL order, trimming the extra probe row before reversing. This makes equal timestamps deterministic and does not require the boundary row to continue to exist. Lists request brief issue shapes, while category counts continue to describe the whole filtered population.

An empty bounded page is treated as stale live data: it offers the inferred opposite direction plus a First page recovery link. Initial empty lists retain their normal creation/filter guidance. Page links are ordinary anchors so reload, browser history, nav memory, scrolling, and keyboard behavior remain native.
