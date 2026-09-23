# Decision: user-entered model rates (2026-09-22)
Tines reopens the earlier no-editable-override decision from Tines/446 for models that have no built-in Codex rate. A user rate is append-only, versioned per exact model and user, and cited by every calculated basis it creates. Built-in catalog rows always win; a user rate cannot replace a reviewed built-in rate.

Saving a rate can explicitly reprice existing runs that are still `unpriced` for `unsupported_model` or `missing_rate`. Repricing is forward-writing, guarded against concurrent updates, limited to 200 rows per pass, and never changes calculated or provider-authoritative rows. Retiring a rate does not change historical bases.

The UI owns the opt-in action and loops bounded passes until no eligible rows remain. Rates are exact decimal strings, not JavaScript numbers, and cache-write `null` deliberately leaves runs with cache-write tokens unpriced.
