import { sql, type Expression, type RawBuilder } from 'kysely';

/**
 * A literal, ASCII-case-insensitive substring predicate.
 *
 * D1 limits LIKE patterns to 50 characters, so a conventional `%term%`
 * pattern fails for ordinary pasted titles. SQLite's lower() retains LIKE's
 * existing ASCII-only case folding while instr() treats every term character
 * literally and accepts long bound values.
 */
export function substringMatch(
	column: Expression<string | null>,
	term: string
): RawBuilder<boolean> {
	return sql<boolean>`instr(lower(${column}), lower(${term})) > 0`;
}
