# Public workflow snapshots

Host reporting and moderation are specified in [MODERATION.md](./MODERATION.md). Public publishing remains default-off until a named reviewer, daily operation, configured appeal contact, and the integrated moderation journey are verified.

Public workflow publication is a revocable hosting layer over the version 3 workflow package. It
does not introduce another package format. A candidate freezes canonical UTF-8 JSON bytes, their
document digest and full-byte checksum, the selected source projection, public display name, MIT
reuse notice, and policy version. Publishing an exactly confirmed candidate allocates one stable URL;
every revision is a new candidate and URL. Source changes never mutate published bytes.

## Authority and lifecycle

Preparation and publication are actor-bound and idempotent. Run keys cannot publish, withdraw,
restore, or install. The publish transaction rechecks source witness, candidate status, publisher
status, size, and the rolling account quota before allocating a snapshot and audit event. Owner
withdrawal makes hosted detail, status, download, and new installation neutrally unavailable.
Policy-controlled host removal and publisher suspension use the same availability predicate and
cannot be reversed by the owner. Owner restoration is allowed only after an owner withdrawal while
host and publisher policy remain active. Completed receipts and distributed files are independent.

Every hosted read is `no-store` and every new hosted installation carries snapshot and publisher
status versions into its signed plan. The receipt transaction rechecks both versions and current
availability. A committed receipt can still be recovered without exposing source text. Publication
and restoration remain disabled unless `PUBLIC_WORKFLOW_PUBLISHING_ENABLED=true`; no committed
deployment enables that switch. Tines/437 owns moderation operations and launch readiness.

## Public content and rendering

Admission applies the strict v3 parser followed by the public text-only policy. Bundled skill files
must be `.md` or `.txt`; binary/media, HTML/SVG files, archives, executables, invalid Unicode and
Markdown images outside literal code are rejected with field/file diagnostics. Required dependencies
are never silently omitted. Repositories remain declarations and are never fetched.

The public reader renders a closed set of escaped text nodes and never uses publisher HTML or creates
image, media, frame, embed, style, script, or automatic resource attributes. Raw HTML/code remains
inert. External HTTP(S) destinations require an explicit dialog action, display the full destination,
open with `noopener noreferrer`, and inherit a no-referrer policy. Unknown, withdrawn, removed, and
suspended snapshots share one neutral unavailable response with no removed text.

## Transport

Same-origin CLI URLs use the hosted prepare path and retain transaction-time withdrawal authority.
For another origin the CLI downloads directly with an isolated HTTP client: no destination
credentials or referrer, canonical URL only, HTTPS except explicit loopback development, DNS result
validation and per-connection pinning, redirect revalidation without downgrade, and bounded time,
bytes, MIME, encoding, and UTF-8. The destination receives bytes, never a URL to fetch. Installation
re-downloads a saved remote source and requires its exact checksum; an already committed destination
receipt remains recoverable if the source later disappears.
