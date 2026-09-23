# Asserted effort for unlisted models (2026-09-22)

This amendment narrows the fail-closed decision in Tines/521. An effort value remains
verified and fail-closed when the exact model is listed in a daemon capability catalog.
When a model is not listed, a recognized effort value may be saved and dispatched as a
user assertion, provided the daemon advertises `accepts_asserted_effort`.

The assertion is deliberately bounded to the shared recognized effort vocabulary. A
daemon that does not advertise the capability rejects the assignment, so rollout is
safe with old daemons. The daemon re-probes before launch; if a fresh catalog lists the
model, the normal listed-model check applies and an excluded value is rejected.

An asserted effort selects its routing target. If the harness rejects the value, the
run fails visibly with the existing rejected evidence instead of silently falling
through to another routing target. The assignment records `verification: asserted`,
while listed values remain verified and existing catalog digests continue to hash only
the model catalog.
