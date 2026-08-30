/**
 * Thrown by the pure input parsers in refs.ts and recurrence-flags.ts, which
 * cannot call `die()` (it is `process.exit`, so it cannot be asserted on in a
 * unit test). Every call site of those parsers unwinds into the top-level
 * `catch` in src/index.ts, whose `reportError` prints `error: <message>` and
 * exits 1 — the same output `die()` produced from inside the parser.
 *
 * Note this is the convention for *these* parsers, not for shared try-parsers:
 * `parsePrSpec` in @tines/shared returns `T | null` and lets the caller pick
 * the message. Here the message belongs with the parser, because
 * `buildRecurrence` alone distinguishes eight failures that a `null` collapses.
 */
export class CliError extends Error {}
