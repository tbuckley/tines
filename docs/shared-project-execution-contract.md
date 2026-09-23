# Proposed 669 → 670 / 712 integration contract

**Status: proposed and unreviewed.** Tines/669 has not landed on `main`; parent
assembly and review must validate this contract before Tines/670 or Tines/712
uses it.

## Identities and authority

- `project.user_id` is the owner of the project event stream and, in 669, the
  only account whose agents can be admitted. `event.actor_user_id` is the real
  caller. `agent_run.user_id` is the contributor/accounting owner, and an
  admitted run records project owner and project ID separately. None of these
  identities may be replaced by another identity merely to reuse an owner
  loader.
- A member's issue or schedule choice is a personal record, bound to that
  person's current membership revision. It never conveys runner, context,
  credential, or project administration access. Browser session authority is
  required for on and off; an API/run key, including Bearer plus cookie,
  cannot supply a choice. Tines/712 may add key consent only after its own
  authorization design and review.
- Issue choice validity includes the issue consent epoch, decision revision,
  current membership revision, and, for inherited choices, live source
  schedule permission epoch and grant revision. Structural resets clear
  effective choices. Rejoin does not revive an old member choice.

## Admission and cancellation

- Claim and delivery share one current authorization predicate. In 669 it
  admits only the project's current owner with an on choice. Delivery repeats
  the claim witness, records admission evidence, and crosses the durable
  `assigned → launching` boundary. One live run remains enforced. An on member
  choice is deliberately ineligible in every path, including resume.
- Off, hold, archive, conversion, and lifecycle invalidation settle only
  unadmitted `assigned` work without an attempt strike. A delivered run may
  drain. Removal also revokes the member's app capability and records bounded
  cancellation intent. An admitted cancellation retains its live slot until
  terminal acknowledgement or established reconciliation; adapter acceptance
  alone is not terminal proof. Re-enabling permission never authorizes a stale
  claim.
- Tines/670 must implement and review separate member runner ownership,
  private context/secret/GitHub delivery, missing-secret guidance on Issues,
  and member-specific claim/delivery/resume proofs before changing the
  hard-coded owner-only admission predicate.

## Shared projection

Project, issue, workflow, schedule, artifact, comment, and activity member
reads use explicit safe fields and current membership. Event rows are stored
once in the project owner's stream with real actor attribution; a member feed
reads those same IDs through a type and payload allowlist. Run logs, owner
fleet/routing, private context, credentials, key metadata, foreign refs, and
account usage are excluded. Later work must extend these allowlists by review,
not by serializing owner responses and hiding UI elements.

Tines/670 should preserve the prominent viewer-private missing-secret/GitHub
warning on Issues. Tines/712 must not treat a named key's general project
write permission as personal consent authority. Both integrations must rerun
the owner/member/key/run/pending/outsider matrix and native D1 claim, delivery,
removal, and cancellation races after changing these boundaries.
