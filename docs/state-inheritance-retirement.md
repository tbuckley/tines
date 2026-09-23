# State-inheritance retirement runbook

This is the Release A / Release B operator procedure for Tines/522. The files in `docs/fixtures/state-retirement/` and `docs/receipts/state-retirement/` are local evidence only; they are not production cutover evidence and contain no credentials.

## Release A: preserve, verify, release

1. Run `tines state-retirement inventory --out inventory.json` as the owning human or owner API key. Review every pointer, source version, scope, payload hash, journal target, launch comparison, and diagnostic. A run key is refused.
2. Create the finite review bundle from the inventory: list each consumer/project/label/issue target, source item and immutable version, proposed local copy name/position, before/after prompt bytes, journal source, and the Context change issues required for shared prompts, skills, repos, and journals. Do not attach credentials or a signed apply token to the review bundle.
3. A human reviews and applies each Context change proposal. The agent does not mutate shared guidance directly. Confirm all affected owners and deployment operators before the hold.
4. Acquire the drain with `tines state-retirement hold --inventory inventory.json --confirm-digest <digest>`. Drain and observe all affected runs. Re-run prepare after the final approved journal append.
5. Run `tines state-retirement prepare --hold <hold> --inventory inventory.json --out plan.json`, review the exact digest and comparisons, then apply with the exact digest. A lost response is recovered by repeating the same plan and digest; do not prepare a replacement plan.
6. Verify with `tines state-retirement receipt <receipt> --verify`. Exact issue targets show the current matcher result, versions, hashes, local-journal target, and launch preview. Targets without a real issue are explicitly marked stage previews; never create a synthetic production issue.
7. Release only after the owner has explicitly confirmed the hold. A successful preservation release is `released_verified`; an unapplied deliberate abandonment is `released_abandoned`. A mismatch or unknown outcome keeps dispatch drained.

## Release B: barrier and deployment

Before B deployment, an authorized deployment-wide operator verifies zero non-null pointers for every owner, every recorded pointer edge has an unrolled-back receipt, all finite comparisons and post-cutover verification are attached, and no unresolved outcome or affected active run remains. An owner-scoped API response cannot prove this condition.

Apply migrations before uploading the worker and stop on migration failure. Test the frozen A worker against the B schema in isolated D1: seed `docs/fixtures/state-retirement/release-a-populated.json`, apply the current-main schema followed by Release A, run inventory → hold → prepare → apply → verify on A, then apply B. The fixture must retain the copied local prompts and journal with pointers null; B must not retain a runtime historical resolver. Test the A worker on the B schema for reads, null-pointer writes, hold claims, and refusal of non-null pointer writes.

The CLI publication job is not proof of worker deployment. Record migration, worker, and CLI outcomes separately, then repeat the all-owner zero-pointer/receipt check after deployment.

## Lost response and rollback limits

An unknown apply response leaves the hold active. Retry the identical plan token, inventory bytes, and confirmation digest to recover the durable receipt. Do not release or edit the plan while the outcome is unknown.

Rollback is a separately signed `rollback-prepare`/`rollback-apply` operation. It is allowed only while the original hold is active and dispatch is drained. The one-use restore authorization can restore only the exact recorded pointer edge and delete only untouched generated copies/files. Any source, local journal, generated payload, scope, version, file, or reference change refuses atomically with zero deletes/restores. The original preservation receipt remains; the rollback receipt links to it and invalidates its pointer coverage until a later verified preservation covers the edge.

After B, do not restore pointers under a B worker. Redeploy A with pointers still null and preserved copies retained. A true pointer restoration requires a separately reviewed maintenance rollback, an additive audited barrier change, a fresh drain, and the guarded reversal. Edited journals are reconciled forward; they are never merged or deleted automatically.

## Review bundle and Context change proposals

Keep the bundle finite and inspectable: inventory bytes/digest, source versions and hashes, exact target matrix, before/after prompt text, copy allocations, journal mapping, active-run drain list, signed plan digest, receipt, verification output, and release SHAs. Every shared change becomes a project issue titled `Context change: <scope label>` with the full proposed text, source/version references, intended owners, and ordering. Human review/application is required; the retirement operator never writes shared context as a substitute.

## Evidence labels

Local fixture evidence is labelled `local` and may be consumed by the B compatibility tests. Human-approved live cutover evidence and post-deployment verification must be recorded separately by the parent assembly pass. Do not invent either category and do not solicit human credentials.
