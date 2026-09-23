# Release A local evidence

Evidence label: `local`.

The populated fixture is `docs/fixtures/state-retirement/release-a-populated.json`. It models a root/child pointer, a project-local journal, an explicit issue target, and the copied local prompt expected after preservation. It is safe input for an isolated native-D1 test and contains no credentials.

The frozen A worker exercise is: apply current-main migrations, apply `0033_state_retirement.sql`, seed the fixture, run `state-retirement inventory`, acquire the reviewed hold, drain the seeded run, prepare and apply the signed plan, verify exact issue targets, then release the hold. Apply the B schema afterward and rerun read-only receipt verification plus null-pointer/old-worker guard checks. The B worker must consume the receipt and copied local items without a runtime legacy resolver.

This file records procedure and fixture expectations only. It is not evidence of a human-approved live cutover, production deployment, all-owner zero-pointer verification, or post-deployment verification.
